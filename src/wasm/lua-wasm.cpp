// The WASM binding. See lua-wasm.h for what this file is and how it relates to
// src/lua-native.cpp; every function here is a port of the native function of
// the same name, and "native:" names where the reasoning lives.

#include "lua-wasm.h"
#include "stack.h"
#include "suspend.h"

#include <emscripten/bind.h>

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <functional>
#include <limits>
#include <stdexcept>
#include <type_traits>
#include <variant>

namespace lua_wasm {

namespace {

// How many entry points have begun, ever. **No native counterpart.** The shell
// reads it straight out of the module's memory before and after each call it
// makes: if a call threw and this moved, C++ had started running and its
// frames were unwound by something it could not catch. It is a counter the
// shell reads rather than a flag C++ raises because C++ cannot be relied on
// to raise anything — when the engine's stack check fires inside a WASM
// function, the frames go without their destructors running (measured,
// November 24, 2026). See "foreign exceptions" in shell.js.
uint32_t& EntriesBegun() {
  static uint32_t count = 0;
  return count;
}

// Runs one entry point and turns its outcome into what the shell expects: the
// value, or the failure sentinel with the exception already handed over.
//
// Native: node-addon-api's callback wrapper, with one deliberate difference.
// There, a `std::exception` that is not a `Napi::Error` escaping an entry
// point terminates the process (the CR-6 F1 class). Here it becomes a JS
// `Error` carrying `what()` — an abort would take the page with it, and a C++
// exception reaching JS as a raw `WebAssembly.Exception` helps nobody.
template <typename Body>
val Entry(Body&& body) {
  ++EntriesBegun();
  // A pending flag left up by a call that was unwound mid-throw would turn
  // this call's success into a failure.
  js::ClearPending();
  try {
    val result = std::forward<Body>(body)();
    if (!js::HasPending()) return result;
  } catch (const js::JsError& e) {
    js::Throw(e.Value());
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
  }
  js::ClearPending();
  return js::FailedSentinel();
}

// What Embind binds: `Method` behind `Entry`, so each entry point's body keeps
// the shape of its native original.
template <val (LuaContext::*Method)(const Args&)>
val Thunk(LuaContext& self, val arguments) {
  return Entry([&]() -> val { return (self.*Method)(Args(std::move(arguments))); });
}

// The same for the functions a handle calls through — a Lua function's call, a
// table handle's methods, a Proxy's traps, an iterator's `next`. Natively each
// is an N-API callback whose `info.Data()` is the handle's struct; here each is
// a method of that struct's Embind class.
template <auto Function, typename Data>
val HandleEntry(Data& data, val arguments) {
  return Entry([&]() -> val { return Function(data, Args(std::move(arguments))); });
}


// Native: NapiToTableKey.
bool NapiToTableKey(const val& value, lua_core::TableKey& out) {
  if (js::IsNumber(value)) {
    const auto d = value.as<double>();
    if (std::isfinite(d) && d == std::trunc(d) &&
        d >= -9223372036854775808.0 && d < 9223372036854775808.0) {
      out = static_cast<int64_t>(d);
    } else {
      out = d;
    }
    return true;
  }
  if (js::IsString(value)) {
    out = js::Utf8(value);
    return true;
  }
  if (js::IsBoolean(value)) {
    out = value.as<bool>();
    return true;
  }
  return false;
}

// --- table references ---------------------------------------------------------

// The struct behind a `_tableRef` owner, or nullptr if `owner` is not one. The
// shell answers from its map of *table* owners, which is this target's type
// tag: an owner of another kind is simply not in it (CR-15 F6).
LuaTableRefData* TaggedTableData(const val& owner) {
  const val handle = js::Host().call<val>("tableData", owner);
  if (handle.isNull()) return nullptr;
  return handle.as<LuaTableRefData*>(emscripten::allow_raw_pointers());
}

// Native: TableRefDataFrom. One Get, and the kind is checked as well as the
// shape.
LuaTableRefData* TableRefDataFrom(const val& value) {
  if (!js::IsObject(value)) return nullptr;
  return TaggedTableData(js::Get(value, "_tableRef"));
}

// Native: RejectIfWorkerBusy. Guards every table-ref trap and handle method.
bool RejectIfWorkerBusy(const LuaTableRefData& data) {
  if (!data.ContextLive() || !data.context) {
    js::ThrowError(std::string("Lua table handle is not usable: ") + data.liveness.DeadReason());
    return true;
  }
  if (data.context->IsBusy()) {
    js::ThrowError("Lua context is busy with an async operation");
    return true;
  }
  return false;
}

// --- Proxy trap functions for LuaTableRef ---

// Native: TableRefGetTrap.
val TableRefGetTrap(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();

  const val target = info[0];
  const val prop = info[1];

  // Skip symbols
  if (!js::IsString(prop)) return val::undefined();

  const std::string key = js::Utf8(prop);

  // Round-trip marker
  if (key == "_tableRef") {
    return js::Get(target, "_tableRef");
  }

  // "then" suppression - prevents Proxy from being treated as a thenable
  if (key == "then") return val::undefined();

  // A Proxy released via lua.release() must fail clearly instead of indexing
  // registry slot LUA_NOREF (nil), matching the table-handle methods.
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }

  try {
    // The CallScope clears the JS-error registry at the outermost access so
    // staged entries can't accumulate across trap calls (L7).
    const LuaContext::CallScope scope(data.context);
    const auto result = data.runtime->GetTableField(data.table_ref.ref, key);
    return data.context->CoreToNapi(*result);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
}

// Native: TableRefSetTrap.
val TableRefSetTrap(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();

  const val prop = info[1];
  const val value = info[2];

  if (!js::IsString(prop)) return val(true);

  const std::string key = js::Utf8(prop);

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val(true);
  }

  try {
    const LuaContext::CallScope scope(data.context);
    const auto core_value = std::make_shared<lua_core::LuaValue>(
      data.context->NapiToCoreInstance(value));
    data.runtime->SetTableField(data.table_ref.ref, key, core_value);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
  }
  return val(true);
}

// Native: TableRefHasTrap.
val TableRefHasTrap(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();

  const val prop = info[1];

  if (!js::IsString(prop)) return val(false);

  const std::string key = js::Utf8(prop);

  if (key == "_tableRef") return val(true);

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val(false);
  }

  try {
    const LuaContext::CallScope scope(data.context);
    const bool has = data.runtime->HasTableField(data.table_ref.ref, key);
    return val(has);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val(false);
  }
}

// Native: TableRefOwnKeysTrap.
val TableRefOwnKeysTrap(const LuaTableRefData& data, const Args& /*info*/) {
  if (RejectIfWorkerBusy(data)) return val::undefined();

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::array();
  }

  try {
    const LuaContext::CallScope scope(data.context);
    auto keys = data.runtime->GetTableKeys(data.table_ref.ref);
    val arr = val::array();
    for (size_t i = 0; i < keys.size(); i++) {
      js::Set(arr, std::to_string(i), js::String(keys[i]));
    }
    return arr;
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::array();
  }
}

// Native: TableRefGetOwnPropertyDescriptorTrap.
val TableRefGetOwnPropertyDescriptorTrap(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();

  const val prop = info[1];

  if (!js::IsString(prop)) return val::undefined();

  const std::string key = js::Utf8(prop);

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }

  try {
    const LuaContext::CallScope scope(data.context);
    if (data.runtime->HasTableField(data.table_ref.ref, key)) {
      const auto value = data.runtime->GetTableField(data.table_ref.ref, key);
      val desc = val::object();
      js::Set(desc, "configurable", val(true));
      js::Set(desc, "enumerable", val(true));
      js::Set(desc, "value", data.context->CoreToNapi(*value));
      return desc;
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
  }
  return val::undefined();
}

// --- Table handle method functions ---

// Native: TableHandleGet.
val TableHandleGet(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }
  if (info.Length() < 1) {
    js::ThrowTypeError("get() requires a key argument");
    return val::undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    js::ThrowTypeError("get() key must be a string, number, or boolean");
    return val::undefined();
  }

  try {
    // Metamethod-capable operation: scoped so a staged JS error from a raising
    // __index host callback is cleared at the next outermost access (CR-8 F5).
    const LuaContext::CallScope scope(data.context);
    const auto result = data.runtime->GetTableFieldKeyed(data.table_ref.ref, key);
    return data.context->CoreToNapi(*result);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
}

// Native: TableHandleGetRef. get_ref(key) — the explicit opt-in to a
// *reference* where get() would hand back a deep copy.
val TableHandleGetRef(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }
  if (info.Length() < 1) {
    js::ThrowTypeError("get_ref() requires a key argument");
    return val::undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    js::ThrowTypeError("get_ref() key must be a string, number, or boolean");
    return val::undefined();
  }

  std::variant<int, std::string> result;
  try {
    // The read runs __index, so it carries the same CallScope discipline as
    // get() (CR-8 F5).
    const LuaContext::CallScope scope(data.context);
    result = data.runtime->GetTableFieldRef(data.table_ref.ref, key);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  if (const auto* error = std::get_if<std::string>(&result)) {
    js::ThrowError(*error);
    return val::undefined();
  }
  return data.context->CreateTableHandle(std::get<int>(result));
}

// Native: TableHandleSet.
val TableHandleSet(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }
  if (info.Length() < 2) {
    js::ThrowTypeError("set() requires key and value arguments");
    return val::undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    js::ThrowTypeError("set() key must be a string, number, or boolean");
    return val::undefined();
  }

  try {
    // See TableHandleGet: CallScope so a raising __newindex host callback's
    // staged entry can't accumulate (CR-8 F5).
    const LuaContext::CallScope scope(data.context);
    const auto value = std::make_shared<lua_core::LuaValue>(
      data.context->NapiToCoreInstance(info[1]));
    data.runtime->SetTableFieldKeyed(data.table_ref.ref, key, value);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
  }
  return val::undefined();
}

// Native: TableHandleHas.
val TableHandleHas(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }
  if (info.Length() < 1) {
    js::ThrowTypeError("has() requires a key argument");
    return val::undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    js::ThrowTypeError("has() key must be a string, number, or boolean");
    return val::undefined();
  }

  try {
    // See TableHandleGet: CallScope for the metamethod-capable probe (CR-8 F5).
    const LuaContext::CallScope scope(data.context);
    const bool exists = data.runtime->HasTableFieldKeyed(data.table_ref.ref, key);
    return val(exists);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val(false);
  }
}

// Native: TableHandleLength.
val TableHandleLength(const LuaTableRefData& data, const Args& /*info*/) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }

  try {
    // See TableHandleGet: CallScope — __len can reach a raising host callback
    // (CR-8 F5).
    const LuaContext::CallScope scope(data.context);
    const int64_t len = data.runtime->GetTableLength(data.table_ref.ref);
    return val(static_cast<double>(len));
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
}

// Native: TableHandlePairs.
val TableHandlePairs(const LuaTableRefData& data, const Args& /*info*/) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }

  try {
    // pairs() fires no metamethod, but the CoreToNapi calls below run the
    // registered Lua->JS converters, which are user JS that can call reset()
    // (CR-13 F1).
    const LuaContext::CallScope scope(data.context);
    auto pairs = data.runtime->TablePairs(data.table_ref.ref);
    val result = val::array();
    for (size_t i = 0; i < pairs.size(); ++i) {
      val entry = val::array();
      js::Set(entry, "0", data.context->CoreToNapi(*pairs[i].first));
      js::Set(entry, "1", data.context->CoreToNapi(*pairs[i].second));
      js::Set(result, std::to_string(i), entry);
    }
    return result;
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
}

// Native: TableHandleKeys. The key snapshot behind `keys()` and
// `[Symbol.iterator]()`.
val TableHandleKeys(const LuaTableRefData& data, const Args& /*info*/) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }

  try {
    const LuaContext::CallScope scope(data.context);  // as TableHandlePairs, CR-13 F1
    auto keys = data.runtime->TableKeys(data.table_ref.ref);
    val result = val::array();
    for (size_t i = 0; i < keys.size(); ++i) {
      js::Set(result, std::to_string(i), data.context->CoreToNapi(*keys[i]));
    }
    return result;
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
}

// Native: KeyToTableKey. Converts a snapshotted key back to the addressing
// type the raw read needs. Total by construction: TableKeys only emits these.
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

// Native: TableIteratorNext.
val TableIteratorNext(LuaTableIterState& state, const Args& /*info*/) {
  const auto finished = []() {
    val out = val::object();
    js::Set(out, "value", val::undefined());
    js::Set(out, "done", val(true));
    return out;
  };

  if (!state.ContextLive()) {
    js::ThrowError(std::string("table handle is not usable: ") + state.liveness.DeadReason());
    return val::undefined();
  }
  // Released mid-loop. Ending the iteration is the honest answer: the entries
  // this cursor was walking are no longer reachable.
  if (!state.data || state.data->table_ref.ref == LUA_NOREF) {
    state.keys.clear();
    return finished();
  }

  try {
    const LuaContext::CallScope scope(state.data->context);
    while (state.index < state.keys.size()) {
      const lua_core::LuaPtr key = state.keys[state.index++];
      lua_core::TableKey addr;
      if (!key || !KeyToTableKey(*key, addr)) continue;

      // Raw, so the cursor reports what `pairs()` reports rather than what an
      // `__index` metamethod would answer.
      const auto value = state.data->runtime->RawGetTableFieldKeyed(
        state.data->table_ref.ref, addr);
      // Deleted between the snapshot and now: skip it, as a traversal that
      // reached the key later would have.
      if (!value || std::holds_alternative<std::monostate>(value->value)) continue;

      val entry = val::array();
      js::Set(entry, "0", state.data->context->CoreToNapi(*key));
      js::Set(entry, "1", state.data->context->CoreToNapi(*value));

      val out = val::object();
      js::Set(out, "value", entry);
      js::Set(out, "done", val(false));
      return out;
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  state.keys.clear();
  return finished();
}

// Native: TableHandleSymbolIterator. The shell passes two things the native
// callback reads off its `info`: `this`, and the owner object of the table,
// which it roots on the cursor (see LuaTableIterState).
val TableHandleSymbolIterator(const LuaTableRefData& data, const Args& info) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }

  auto state = std::make_unique<LuaTableIterState>();
  state->data = &data;
  state->liveness = data.liveness;  // the handle already carries it
  if (js::IsObject(info[0])) state->handle = info[0];

  // The snapshot happens here, at `[Symbol.iterator]()`, not at the first
  // `next()`: it is the traversal, and it must complete before any JS the loop
  // body runs can touch the table.
  try {
    const LuaContext::CallScope scope(data.context);
    state->keys = data.runtime->TableKeys(data.table_ref.ref);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  LuaTableIterState* state_ptr = state.get();
  val iterator = js::Host().call<val>(
    "tableIterator", val(state_ptr, emscripten::allow_raw_pointers()),
    data.context->ShellState(), info[1]);
  // NOLINTNEXTLINE(bugprone-unused-return-value): the shell's handle owns it now
  (void)state.release();
  return iterator;
}

// Native: TableHandleIPairs.
val TableHandleIPairs(const LuaTableRefData& data, const Args& /*info*/) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }

  try {
    // See TableHandleGet: CallScope — the ipairs collection respects __index
    // (CR-8 F5), and it converts results through user JS (CR-13 F1).
    const LuaContext::CallScope scope(data.context);
    auto ipairs = data.runtime->TableIPairs(data.table_ref.ref);
    val result = val::array();
    for (size_t i = 0; i < ipairs.size(); ++i) {
      val entry = val::array();
      js::Set(entry, "0", val(static_cast<double>(ipairs[i].first)));
      js::Set(entry, "1", data.context->CoreToNapi(*ipairs[i].second));
      js::Set(result, std::to_string(i), entry);
    }
    return result;
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
}

// Native: TableHandleRelease.
val TableHandleRelease(LuaTableRefData& data, const Args& /*info*/) {
  if (RejectIfWorkerBusy(data)) return val::undefined();
  if (data.table_ref.ref == LUA_NOREF) {
    // Already released — no-op
    return val::undefined();
  }

  // Drop this handle's share of the registry slot (unref'd iff it was the last
  // owner) and mark the handle released.
  data.table_ref.release();
  return val::undefined();
}

// Native: LuaFunctionCallbackStatic. The native null checks on `data` and its
// members have no counterpart: the shell can only reach this through a live
// handle, and the handle is this struct.
val LuaFunctionCallbackStatic(const LuaFunctionData& data, const Args& info) {
  if (!data.runtime || !data.context || !data.ContextLive()) {
    js::ThrowError(std::string("Lua function is not usable: ") + data.liveness.DeadReason());
    return val::undefined();
  }

  // A released ref would rawget registry slot LUA_NOREF (nil) and fail with an
  // opaque "attempt to call a nil value" — surface a clear error instead.
  if (data.func_ref.ref == LUA_NOREF) {
    js::ThrowError("Lua function has been released");
    return val::undefined();
  }

  // Reject reentry while any async op is in flight.
  if (data.context->IsBusy()) {
    js::ThrowError("Lua context is busy with an async operation");
    return val::undefined();
  }

  // Above the argument conversion, not just around the call: the converters it
  // runs are user JS (CR-13 F1).
  const LuaContext::CallScope call_scope(data.context);

  // One collector spans every argument so that a later argument failing to
  // convert sweeps the reclaimable callbacks minted by the earlier ones (F1).
  const LuaContext::JsCallbackCollectorScope collector(data.context);
  std::vector<lua_core::LuaPtr> args;
  args.reserve(info.Length());
  try {
    for (uint32_t i = 0; i < info.Length(); ++i) {
      args.push_back(std::make_shared<lua_core::LuaValue>(
        data.context->NapiToCoreInstance(info[i])));
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  const auto result = data.runtime->CallFunction(data.func_ref, args);
  if (std::holds_alternative<std::string>(result)) {
    data.context->ThrowLuaError(std::get<std::string>(result));
    return val::undefined();
  }
  return data.context->ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result));
}

// Native: SplitGlobalPath.
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

// Native: SizeLimitFromNumber.
std::optional<size_t> SizeLimitFromNumber(const double num) {
  if (!(num >= 0)) return std::nullopt;  // negative, or NaN
  constexpr auto kLimitExclusive = static_cast<double>(std::numeric_limits<size_t>::max());
  if (num >= kLimitExclusive) return std::numeric_limits<size_t>::max();
  return static_cast<size_t>(num);
}

// The same rule for the three limits a context is built with, which the core
// holds in 64 bits on every target. Natively this is SizeLimitFromNumber,
// because `size_t` is that wide there; here `size_t` is 32 bits, and reading a
// limit through it made `Infinity` saturate at 2^32-1 — a real ceiling of
// about 4.29 billion instructions (docs/reviews/WASM-TARGET-PLAN.md, slice 7).
std::optional<std::uint64_t> LimitFromNumber(const double num) {
  if (!(num >= 0)) return std::nullopt;  // negative, or NaN
  constexpr auto kLimitExclusive = static_cast<double>(std::numeric_limits<std::uint64_t>::max());
  if (num >= kLimitExclusive) return std::numeric_limits<std::uint64_t>::max();
  return static_cast<std::uint64_t>(num);
}

// Native: ConvertBuiltinType.
std::optional<lua_core::LuaValue> ConvertBuiltinType(
    const val& value, const int depth,
    const std::function<lua_core::LuaValue(const val&, int)>& recurse) {
  const js::ObjectKind object_kind = js::ObjectKindOf(value);

  // Binary data -> binary-safe Lua string.
  if (object_kind == js::ObjectKind::Binary) {
    return lua_core::LuaValue::from(js::Bytes(value));
  }

  // Date -> epoch milliseconds (double)
  if (object_kind == js::ObjectKind::Date) {
    return lua_core::LuaValue::from(js::DateValue(value));
  }

  // Map -> Lua table. Keys are stringified, matching plain-object behavior.
  if (js::InstanceOfGlobal(value, "Map")) {
    const val entries = js::ArrayFrom(value);
    const auto count = js::Get(entries, "length").as<uint32_t>();
    lua_core::LuaTable tbl;
    for (uint32_t i = 0; i < count; ++i) {
      const val pair = js::GetIndex(entries, i);
      std::string k = js::ToString(js::GetIndex(pair, 0));
      tbl.emplace(std::move(k), std::make_shared<lua_core::LuaValue>(
        recurse(js::GetIndex(pair, 1), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(tbl));
  }

  // Set -> Lua array
  if (js::InstanceOfGlobal(value, "Set")) {
    const val vals = js::ArrayFrom(value);
    const auto count = js::Get(vals, "length").as<uint32_t>();
    lua_core::LuaArray arr;
    arr.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
      arr.push_back(std::make_shared<lua_core::LuaValue>(recurse(js::GetIndex(vals, i), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(arr));
  }

  // RegExp -> its source pattern string (flags are dropped)
  if (js::InstanceOfGlobal(value, "RegExp")) {
    return lua_core::LuaValue::from(js::ToString(js::Get(value, "source")));
  }

  return std::nullopt;
}

// Native: NumberToCore.
lua_core::LuaValue NumberToCore(const double num) {
  if (num == 0.0 && std::signbit(num)) {
    return lua_core::LuaValue::from(num);  // stays a float, keeps the sign
  }
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

// The constructor's option parsing. Native: the functions of the same names.
// **The order of the reads is part of the behaviour**: an options object with
// getters observes it.

bool ReadLimitOption(const val& options, const char* key, std::uint64_t& value, bool& present) {
  if (!js::Has(options, key)) return true;
  const val raw = js::Get(options, key);
  if (js::IsNumber(raw)) {
    const auto limit = LimitFromNumber(raw.as<double>());
    if (!limit) {
      js::ThrowRangeError(std::string(key) + " must be a non-negative number");
      return false;
    }
    value = *limit;
    present = true;
    return true;
  }
  if (!js::IsNullish(raw)) {
    js::ThrowTypeError(std::string(key) + " must be a number");
    return false;
  }
  return true;
}

bool ReadStrictConversionOption(const val& options, bool& strict_conversion) {
  if (!js::Has(options, "strictConversion")) return true;
  const val strict_val = js::Get(options, "strictConversion");
  if (js::IsBoolean(strict_val)) {
    strict_conversion = strict_val.as<bool>();
    return true;
  }
  if (!js::IsNullish(strict_val)) {
    js::ThrowTypeError("strictConversion must be a boolean");
    return false;
  }
  return true;
}

bool ApplyLibraryPreset(const std::string& preset, ContextInitOptions& init) {
  if (preset == "all") {
    init.libraries = lua_core::LuaRuntime::AllLibraries();
  } else if (preset == "safe") {
    init.libraries = lua_core::LuaRuntime::SafeLibraries();
  } else if (preset == "sandbox") {
    init.libraries = lua_core::LuaRuntime::SandboxLibraries();
    init.seal_base_filesystem = true;
    init.sandbox_preset = true;
  } else {
    js::ThrowTypeError("libraries must be 'all', 'safe', 'sandbox', or an array of library names");
    return false;
  }
  return true;
}

bool ReadLibrariesOption(const val& options, ContextInitOptions& init) {
  if (!js::Has(options, "libraries")) return true;
  const val libs_val = js::Get(options, "libraries");
  if (js::IsArray(libs_val)) {
    const auto count = js::Get(libs_val, "length").as<uint32_t>();
    init.libraries.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
      if (!js::IsString(js::GetIndex(libs_val, i))) {
        js::ThrowTypeError("libraries array must contain only strings");
        return false;
      }
      init.libraries.push_back(js::Utf8(js::GetIndex(libs_val, i)));
    }
    init.has_libraries = true;
    return true;
  }
  if (js::IsString(libs_val)) {
    if (!ApplyLibraryPreset(js::Utf8(libs_val), init)) return false;
    init.has_libraries = true;
    return true;
  }
  js::ThrowTypeError("libraries must be 'all', 'safe', 'sandbox', or an array of library names");
  return false;
}

bool ParseInitOptions(const val& options, ContextInitOptions& init) {
  return ReadLimitOption(options, "maxMemory", init.max_memory, init.has_max_memory) &&
         ReadLimitOption(options, "maxInstructions", init.max_instructions,
                         init.has_max_instructions) &&
         ReadLimitOption(options, "timeout", init.timeout_ms, init.has_timeout) &&
         ReadStrictConversionOption(options, init.strict_conversion) &&
         ReadLibrariesOption(options, init);
}

// Native: ParseChunkName.
bool ParseChunkName(const Args& info, const uint32_t index, const char* door, std::string& out) {
  if (info.Length() <= index) return true;
  const val opts = info[index];
  if (js::IsNullish(opts)) return true;
  if (js::KindOf(opts) != js::Kind::Object) {
    js::ThrowTypeError(std::string(door) + " options must be an object");
    return false;
  }
  const val name = js::Get(opts, "chunkName");
  if (js::IsNullish(name)) return true;
  if (!js::IsString(name)) {
    js::ThrowTypeError(std::string(door) + " chunkName must be a string");
    return false;
  }
  out = js::Utf8(name);
  return true;
}

// Native: ReadEnvironmentWhitelist. Returns false with a JS exception pending.
bool ReadEnvironmentWhitelist(const val& options, std::vector<std::string>& whitelist) {
  if (!js::Has(options, "whitelist")) return true;
  const val list = js::Get(options, "whitelist");
  if (js::IsNullish(list)) return true;
  if (!js::IsArray(list)) {
    js::ThrowTypeError("create_environment(): whitelist must be an array of strings");
    return false;
  }
  const auto count = js::Get(list, "length").as<uint32_t>();
  whitelist.reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    const val entry = js::GetIndex(list, i);
    if (!js::IsString(entry)) {
      js::ThrowTypeError("create_environment(): whitelist entries must be strings");
      return false;
    }
    whitelist.push_back(js::Utf8(entry));
  }
  return true;
}

// Native: ReadEnvironmentOptions. The caller holds the CallScope: these reads
// can be Proxy-trapped or accessor-backed. Returns false with a JS exception
// pending.
bool ReadEnvironmentOptions(const val& arg, std::vector<std::string>& whitelist, bool& inherit) {
  if (!js::IsObject(arg) || js::IsArray(arg) || js::IsFunction(arg)) {
    js::ThrowTypeError("create_environment() options must be an object");
    return false;
  }
  if (!ReadEnvironmentWhitelist(arg, whitelist)) return false;

  if (js::Has(arg, "inherit")) {
    const val v = js::Get(arg, "inherit");
    if (!js::IsNullish(v)) inherit = !(!v);  // ToBoolean
  }
  return true;
}

// --- userdata and classes ------------------------------------------------------

// The struct behind a `_userdata` owner, or nullptr if `owner` is not one.
// Native: TaggedData<LuaUserdataData>(…, kUserdataData).
LuaUserdataData* TaggedUserdataData(const val& owner) {
  const val handle = js::Host().call<val>("userdataData", owner);
  if (handle.isNull()) return nullptr;
  return handle.as<LuaUserdataData*>(emscripten::allow_raw_pointers());
}

using ClassFunctionList = std::vector<std::pair<std::string, val>>;

// Native: ReadUserdataOptions. The caller holds the CallScope: every read here
// can be a getter that re-enters the context (CR-13 F1).
void ReadUserdataOptions(const val& options, bool& readable, bool& writable,
                         ClassFunctionList& method_funcs) {
  if (js::Has(options, "readable") && js::IsBoolean(js::Get(options, "readable"))) {
    readable = js::Get(options, "readable").as<bool>();
  }
  if (js::Has(options, "writable") && js::IsBoolean(js::Get(options, "writable"))) {
    writable = js::Get(options, "writable").as<bool>();
  }
  if (!js::Has(options, "methods") || !js::IsObject(js::Get(options, "methods"))) return;
  const val methods_obj = js::Get(options, "methods");
  const val method_keys = js::Keys(methods_obj);
  const uint32_t count = js::Length(method_keys);
  for (uint32_t i = 0; i < count; i++) {
    std::string method_name = js::Utf8(method_keys[i]);
    const val method_val = js::Get(methods_obj, method_name);
    if (js::IsFunction(method_val)) {
      method_funcs.emplace_back(std::move(method_name), method_val);
    }
  }
}

// register_class's reads of its definition object, one function per property.
// **Each property is read exactly once, into a snapshot** (N3), in the order
// RegisterClass calls these. Each bool-returning reader returns false with a JS
// exception pending. Native: the functions of the same names.

// Native: ReadClassExtends. The base must already be registered on THIS context.
bool ReadClassExtends(const val& def, const std::string& class_name,
                      const std::unordered_set<std::string>& registered,
                      std::string& parent_class) {
  if (const val extends_val = js::Get(def, "extends"); !js::IsNullish(extends_val)) {
    if (!js::IsString(extends_val)) {
      js::ThrowTypeError("register_class(): 'extends' must be the name of a registered class");
      return false;
    }
    parent_class = js::Utf8(extends_val);
    if (parent_class == class_name || registered.count(parent_class) == 0) {
      js::ThrowError("register_class(): base class '" + parent_class + "' is not registered");
      return false;
    }
  }
  return true;
}

// Native: ReadClassMetamethods. Reserved metamethods are rejected up front,
// before anything is registered (L4).
bool ReadClassMetamethods(const val& def, ClassFunctionList& mm_snapshot) {
  const val mms_val = js::Get(def, "metamethods");
  if (js::IsObject(mms_val)) {
    const val mm_keys = js::Keys(mms_val);
    const uint32_t count = js::Length(mm_keys);
    for (uint32_t i = 0; i < count; ++i) {
      std::string key = js::Utf8(mm_keys[i]);
      if (key == "__gc" || key == "__index" || key == "__newindex" ||
          key == "__name" || key == lua_core::LuaRuntime::kClassMarkerField) {
        js::ThrowTypeError(
          "register_class(): metamethod '" + key + "' is reserved and cannot be overridden");
        return false;
      }
      const val value = js::Get(mms_val, key);
      if (js::IsFunction(value)) {
        mm_snapshot.emplace_back(std::move(key), value);
      }
    }
  }
  return true;
}

// Native: ReadClassStatics. Functions and plain values are separated here
// because they take different routes into the class table.
bool ReadClassStatics(const val& def, ClassFunctionList& static_fn_snapshot,
                      ClassFunctionList& static_val_snapshot) {
  const val statics_val = js::Get(def, "statics");
  if (js::KindOf(statics_val) == js::Kind::Object) {
    const val keys = js::Keys(statics_val);
    const uint32_t count = js::Length(keys);
    for (uint32_t i = 0; i < count; ++i) {
      std::string key = js::Utf8(keys[i]);
      if (key == "new") {
        js::ThrowTypeError("register_class(): static 'new' is reserved — it is the constructor");
        return false;
      }
      const val value = js::Get(statics_val, key);
      if (js::IsFunction(value)) {
        static_fn_snapshot.emplace_back(std::move(key), value);
      } else {
        static_val_snapshot.emplace_back(std::move(key), value);
      }
    }
  }
  return true;
}

// Native: ReadClassProperties. Named property accessors (P2b).
bool ReadClassProperties(const val& def, ClassAccessorTable& accessors) {
  const val props_val = js::Get(def, "properties");
  if (js::KindOf(props_val) == js::Kind::Object) {
    const val keys = js::Keys(props_val);
    const uint32_t count = js::Length(keys);
    for (uint32_t i = 0; i < count; ++i) {
      std::string key = js::Utf8(keys[i]);
      const val entry = js::Get(props_val, key);
      if (js::KindOf(entry) != js::Kind::Object) {
        js::ThrowTypeError(
          "register_class(): property '" + key + "' must be an object with "
          "'get' and/or 'set' functions");
        return false;
      }
      const val get_val = js::Get(entry, "get");
      const val set_val = js::Get(entry, "set");
      const bool has_get = js::IsFunction(get_val);
      const bool has_set = js::IsFunction(set_val);
      if (!has_get && !has_set) {
        js::ThrowTypeError(
          "register_class(): property '" + key + "' declares neither 'get' nor 'set'");
        return false;
      }
      ClassAccessor acc;
      if (has_get) acc.getter = get_val;
      if (has_set) acc.setter = set_val;
      accessors.props.emplace(std::move(key), std::move(acc));
    }
  }
  return true;
}

// Native: ReadClassMethods. Instance methods (obj:method()), read last.
void ReadClassMethods(const val& def, const uint64_t class_id,
                      std::unordered_map<std::string, std::string>& method_map,
                      ClassFunctionList& deferred_fns) {
  const val methods_val = js::Get(def, "methods");
  if (!js::IsObject(methods_val)) return;
  const val keys = js::Keys(methods_val);
  const uint32_t count = js::Length(keys);
  for (uint32_t i = 0; i < count; ++i) {
    const std::string name = js::Utf8(keys[i]);
    const val value = js::Get(methods_val, name);
    if (js::IsFunction(value)) {
      std::string func_name = "__class_method_" + std::to_string(class_id) + "_" + name;
      deferred_fns.emplace_back(func_name, value);
      method_map[name] = func_name;
    }
  }
}

// Native: kAsyncBusyMessage. The AsyncInFlight refusal. One definition because
// two kinds of site say it: RejectIfOccupied, which throws it, and the
// coroutine-driven doors, which reject a promise with it at their commit point
// (see BeginAsyncRun).
constexpr const char* kAsyncBusyMessage = "Lua context is busy with an async operation";

// --- coroutines ---------------------------------------------------------------

// Native: CoroutineStatusName.
const char* CoroutineStatusName(const lua_core::CoroutineStatus status) {
  switch (status) {
    case lua_core::CoroutineStatus::Suspended: return "suspended";
    case lua_core::CoroutineStatus::Running:   return "running";
    case lua_core::CoroutineStatus::Dead:      return "dead";
  }
  return "dead";
}

// The struct behind a `_coroutine` owner, or nullptr if `owner` is not one.
// Native: TaggedData<LuaThreadData>(…, kThreadData).
LuaThreadData* TaggedThreadData(const val& owner) {
  const val handle = js::Host().call<val>("threadData", owner);
  if (handle.isNull()) return nullptr;
  return handle.as<LuaThreadData*>(emscripten::allow_raw_pointers());
}

// Native: LuaFunctionDataFrom. The struct behind a Lua function handed back to
// JS, or nullptr for a plain JS function. One Get, and branded (CR-15 F6).
LuaFunctionData* LuaFunctionDataFrom(const val& value) {
  if (!js::IsFunction(value)) return nullptr;
  const val handle = js::Host().call<val>("functionData", js::Get(value, "__luaFnOwner"));
  if (handle.isNull()) return nullptr;
  return handle.as<LuaFunctionData*>(emscripten::allow_raw_pointers());
}

// Native: ScopedFlag.
class ScopedFlag {
 public:
  explicit ScopedFlag(bool& flag) : flag_(&flag) { *flag_ = true; }
  ~ScopedFlag() { *flag_ = false; }
  ScopedFlag(const ScopedFlag&) = delete;
  ScopedFlag& operator=(const ScopedFlag&) = delete;

 private:
  bool* flag_;
};

// A promise already rejected with a fresh Error. Native: the `reject` lambdas.
val RejectedPromise(const std::string& message) {
  const Deferred deferred = Deferred::New();
  deferred.Reject(js::NewErrorValue(message));
  return deferred.Promise();
}

val ResolvedPromise(const val& value) {
  const Deferred deferred = Deferred::New();
  deferred.Resolve(value);
  return deferred.Promise();
}

// Native: CoroIterResult.
val CoroIterResult(const val& value, const bool done) {
  val result = val::object();
  js::Set(result, "value", value);
  js::Set(result, "done", val(done));
  return result;
}

// One `{ status, values, error? }` step as the `{ value, done }` an iterator
// answers with. Shared by the two cursors, which natively each spell it out:
// they differ in *when* they get the step, not in what a step means. Returns
// undefined with a JS exception pending when the step carried an error.
val CoroStepToIterResult(LuaCoroIterState& state, const val& result) {
  if (js::Has(result, "error")) {
    state.done = true;
    js::ThrowError(js::ToString(js::Get(result, "error")));
    return val::undefined();
  }

  // A yield is an iteration step; the coroutine's final `return` arrives with
  // done=true, which for..of discards — exactly the JS generator contract.
  const bool dead = js::ToString(js::Get(result, "status")) == "dead";
  if (dead) state.done = true;

  const val values = js::Get(result, "values");
  const uint32_t count = js::Length(values);
  val value = val::undefined();
  if (count == 1) {
    value = js::GetIndex(values, 0);
  } else if (count > 1) {
    value = values;  // multiple yielded values arrive as an array, as elsewhere
  }
  return CoroIterResult(value, dead);
}

// True when the cursor's coroutine is already dead — exhausted by an earlier
// loop, or driven to completion by hand. `this` was user-supplied, so the Get
// can be a trap and the owner it returns any the module has handed out;
// branded, so a wrong-kind one simply declines (CR-15 F6).
bool CursorCoroutineIsDead(const val& coro) {
  const auto* thread_data = TaggedThreadData(js::Get(coro, "_coroutine"));
  return thread_data != nullptr && thread_data->thread_ref.ref != LUA_NOREF &&
         lua_core::LuaRuntime::GetCoroutineStatus(thread_data->thread_ref) ==
           lua_core::CoroutineStatus::Dead;
}

// Native: CoroIteratorNext.
val CoroIteratorNext(LuaCoroIterState& state, const Args& info) {
  if (!state.ContextLive()) {
    js::ThrowError(std::string("Lua coroutine is not usable: ") + state.liveness.DeadReason());
    return val::undefined();
  }
  if (state.done) return CoroIterResult(val::undefined(), true);

  const val coro = state.coro;

  // An already-dead coroutine simply ends the iteration, rather than surfacing
  // Lua's "cannot resume dead coroutine" as a thrown error.
  if (CursorCoroutineIsDead(coro)) {
    state.done = true;
    return CoroIterResult(val::undefined(), true);
  }

  if (state.context->IsBusy()) {
    js::ThrowError("Lua context is busy with an async operation");
    return val::undefined();
  }

  // Same outermost-entry bookkeeping resume() does (L7), opened above the
  // argument handling and the resume it feeds (CR-13 F1).
  const LuaContext::CallScope scope(state.context);

  // `next(v)` forwards its arguments as the resume values.
  std::vector<val> args;
  args.reserve(info.Length());
  for (uint32_t i = 0; i < info.Length(); ++i) args.push_back(info[i]);

  const val res = state.context->ResumeCoroutineObject(coro, args);
  if (js::HasPending() || !js::IsObject(res)) {
    state.done = true;  // a broken cursor must not be resumable
    return val::undefined();
  }
  return CoroStepToIterResult(state, res);
}

// Native: CoroAsyncNextMap. `info[0]` is the `{ status, values, error? }` the
// resume_async promise resolved with.
val CoroAsyncNextMap(LuaCoroIterState& state, const Args& info) {
  const val res = info[0];
  if (!js::IsObject(res)) {
    state.done = true;
    return CoroIterResult(val::undefined(), true);
  }
  return CoroStepToIterResult(state, res);
}

// Native: CoroAsyncIteratorNext. The async cursor's `next()`, driven through
// resume_async so a host function that returns a Promise anywhere inside the
// coroutine suspends it. `info` is what the shell packed: the cursor's owner,
// then the caller's own arguments.
val CoroAsyncIteratorNext(LuaCoroIterState& state, const Args& info) {
  const val owner = info[0];
  const Args call(info[1]);

  // Everything past the liveness check settles a promise rather than throwing,
  // so `for await` sees failures through its normal channel.
  if (!state.ContextLive()) {
    return RejectedPromise(std::string("Lua coroutine is not usable: ") +
                           state.liveness.DeadReason());
  }
  if (state.done) return ResolvedPromise(CoroIterResult(val::undefined(), true));

  const val coro = state.coro;

  if (CursorCoroutineIsDead(coro)) {
    state.done = true;
    return ResolvedPromise(CoroIterResult(val::undefined(), true));
  }

  std::vector<val> args;
  args.reserve(call.Length());
  for (uint32_t i = 0; i < call.Length(); ++i) args.push_back(call[i]);

  // No CallScope around the drive: resume_async suspends and returns, so a
  // scope held here would leave call_depth_ raised across the await (CR-10 F1).
  // No busy check here either, unlike CoroIteratorNext:
  // ResumeCoroutineObjectAsync makes it, and answers with a rejected promise —
  // which the `then` below passes through without calling the mapper, so
  // `done` stays false.
  const val promise =
    state.context->ResumeCoroutineObjectAsync(coro, args, state.context->Self());
  if (js::HasPending()) {
    state.done = true;  // a broken cursor must not be resumable
    return val::undefined();
  }
  if (!js::IsPromise(promise)) {
    state.done = true;
    return RejectedPromise("resume_async did not return a Promise");
  }

  // `then` is user-influenceable (a patched Promise.prototype), so a failure
  // here must not leave the cursor in a half-advanced state.
  const val then_val = js::Get(promise, "then");
  if (!js::IsFunction(then_val)) {
    state.done = true;
    return RejectedPromise("the Promise from resume_async has no callable 'then'");
  }
  // The mapper roots the cursor itself: it runs when the promise settles,
  // which can be after `next` and the iterator have both been dropped, leaving
  // it the only holder (H3 / L6).
  const val mapper = js::Host().call<val>("coroAsyncMapper", owner);
  return js::CallWithThis(then_val, promise, {mapper});
}

// Native: CoroIteratorReturn. Called when a for..of loop exits early. Ends this
// cursor only — the coroutine keeps its suspension point.
val CoroIteratorReturn(LuaCoroIterState& state, const Args& info) {
  state.done = true;
  return CoroIterResult(info[0], true);
}

// What both iterator factories do once they have checked their receiver.
val NewCoroCursor(const LuaContextBinding& binding, const val& coro, const bool is_async) {
  auto state = std::make_unique<LuaCoroIterState>();
  state->context = binding.context;
  state->liveness = binding.liveness;
  state->coro = coro;
  val iterator = js::Host().call<val>("coroIterator",
                                      val(state.get(), emscripten::allow_raw_pointers()),
                                      binding.context->ShellState(), is_async);
  // NOLINTNEXTLINE(bugprone-unused-return-value): the shell's handle owns it now
  (void)state.release();
  return iterator;
}

// Native: CoroSymbolIterator. The coroutine object's `[Symbol.iterator]`;
// `info[0]` is the receiver.
val CoroSymbolIterator(const LuaContextBinding& binding, const Args& info) {
  if (!binding.ContextLive()) {
    js::ThrowError(std::string("Lua coroutine is not usable: ") + binding.liveness.DeadReason());
    return val::undefined();
  }
  if (!js::IsObject(info[0])) {
    js::ThrowTypeError("coroutine[Symbol.iterator]() must be called on a coroutine object");
    return val::undefined();
  }
  return NewCoroCursor(binding, info[0], false);
}

// Native: CoroSymbolAsyncIterator (P1b).
val CoroSymbolAsyncIterator(const LuaContextBinding& binding, const Args& info) {
  if (!binding.ContextLive()) {
    js::ThrowError(std::string("Lua coroutine is not usable: ") + binding.liveness.DeadReason());
    return val::undefined();
  }
  if (!js::IsObject(info[0])) {
    js::ThrowTypeError("coroutine[Symbol.asyncIterator]() must be called on a coroutine object");
    return val::undefined();
  }
  return NewCoroCursor(binding, info[0], true);
}

// --- the await driver's continuations, and the two deferred doors -----------------

// Native: LuaContext::OnAwaitResolveStatic / OnAwaitRejectStatic.
val AwaitSettledStatic(AwaitCookie& cookie, const Args& info, const bool is_error) {
  // Ignore a duplicate settlement (a hostile or broken promise firing twice).
  if (cookie.settled) return val::undefined();
  cookie.settled = true;
  // The context may have been destroyed since the callbacks were attached.
  // Check the shared liveness flag BEFORE touching ctx (CR-7 F1).
  if (!cookie.alive || !cookie.alive->load()) return val::undefined();
  return cookie.ctx->OnAwaitSettled(info[0], is_error, cookie.gen);
}

val OnAwaitResolveStatic(AwaitCookie& cookie, const Args& info) {
  return AwaitSettledStatic(cookie, info, false);
}

val OnAwaitRejectStatic(AwaitCookie& cookie, const Args& info) {
  return AwaitSettledStatic(cookie, info, true);
}

// Why the two deferred doors use kExclusive natively: they hand the lua_State
// to a libuv thread. The text is kept, as every refusal's is (plan, D2), so
// that a caller sees one message on both targets.
constexpr const char* kWorkerHandoffDetail =
  "handing the state to a worker thread requires that nothing else holds it";

// Native: WorkerRunScope. Brackets one such run: host callbacks are refused
// for its duration, which is the rule a script meets natively on a worker.
class WorkerRunScope {
 public:
  explicit WorkerRunScope(lua_core::LuaRuntime* runtime) : runtime_(runtime) {
    runtime_->BeginWorkerUnrefDeferral();
    runtime_->SetAsyncMode(true);
  }
  ~WorkerRunScope() {
    runtime_->SetAsyncMode(false);
    runtime_->EndWorkerUnrefDeferral();
  }
  WorkerRunScope(const WorkerRunScope&) = delete;
  WorkerRunScope& operator=(const WorkerRunScope&) = delete;

 private:
  lua_core::LuaRuntime* runtime_;
};

// Arms the runtime's pause hook for a run the shell can suspend.
class PauseScope {
 public:
  PauseScope(lua_core::LuaRuntime* runtime, const bool suspendable) : runtime_(runtime) {
    if (suspendable) runtime_->SetPauseHook(&js::PauseIfDue);
    js::StartSlice();
  }
  ~PauseScope() { runtime_->SetPauseHook(nullptr); }
  PauseScope(const PauseScope&) = delete;
  PauseScope& operator=(const PauseScope&) = delete;

 private:
  lua_core::LuaRuntime* runtime_;
};

// Native: a worker's Execute. Runs no user JS, so it may be suspended: the
// shell calls it through suspend.h's export when the engine can.
void WorkerExecute(LuaWorkerRun& run) {
  try {
    const WorkerRunScope scope(run.runtime.get());
    const PauseScope pausing(run.runtime.get(), run.suspendable);
    run.result = run.is_file ? run.runtime->ExecuteFile(run.source)
                             : run.runtime->ExecuteScript(run.source, run.chunk_name);
  } catch (const std::exception& e) {
    run.failure = e.what();
  }
}

// WorkerExecute as a table entry, which is how the shell calls it with nothing
// of JavaScript's on the stack between.
void WorkerExecuteEntry(LuaWorkerRun* run) { WorkerExecute(*run); }

double WorkerExecuteEntryIndex() {
  return static_cast<double>(reinterpret_cast<uintptr_t>(&WorkerExecuteEntry));
}

double WorkerAddress(const LuaWorkerRun& run) {
  return static_cast<double>(reinterpret_cast<uintptr_t>(&run));
}

// The top of a stack of the run's own, or 0 if there is no memory for one.
double WorkerStackTop(LuaWorkerRun& run) {
  // As large as the module's (STACK_SIZE in tools/wasm-build/run.mjs).
  constexpr size_t kBytes = size_t{1024} * 1024;
  run.stack.reset(new (std::nothrow) char[kBytes]);
  if (!run.stack) return 0;
  run.suspendable = true;
  const auto top = reinterpret_cast<uintptr_t>(run.stack.get()) + kBytes;
  return static_cast<double>(top & ~uintptr_t{15});
}

double WorkerStackBottom(const LuaWorkerRun& run) {
  return static_cast<double>(reinterpret_cast<uintptr_t>(run.stack.get()));
}

// Native: a worker's OnOK or OnError. Never leaves a JS exception pending:
// every outcome settles the promise.
val WorkerFinish(LuaWorkerRun& run, const Args& /*info*/) {
  // OnError: an exception out of Execute.
  if (run.failure) {
    run.context->ClearBusy();
    run.deferred.Reject(js::NewErrorValue(*run.failure));
    return val::undefined();
  }

  // OnOK. The marshal below runs user JS (the Lua->JS converters) over values
  // that hold the running state's registry refs; the CallScope is what refuses
  // a reset() from there once is_busy_ has been dropped (CR-14 F1).
  run.context->ClearBusy();
  const LuaContext::CallScope call_scope(run.context);

  if (std::holds_alternative<std::string>(run.result)) {
    run.deferred.Reject(js::NewErrorValue(std::get<std::string>(run.result)));
    return val::undefined();
  }
  // Marshalling can throw; reject rather than unwind (CR-8 F4).
  try {
    run.deferred.Resolve(
      run.context->ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(run.result)));
  } catch (const std::exception& e) {
    run.deferred.Reject(js::NewErrorValue(
      std::string("failed to convert async result: ") + e.what()));
  }
  return val::undefined();
}

// Both, on the spot: what an engine that cannot suspend gets.
val WorkerRun(LuaWorkerRun& run, const Args& info) {
  WorkerExecute(run);
  return WorkerFinish(run, info);
}

}  // namespace

Deferred Deferred::New() { return Deferred(js::Host().call<val>("deferred")); }

Args::Args(val arguments) : list(std::move(arguments)), length(js::Length(list)) {}

val Args::operator[](const uint32_t index) const {
  return index < length ? list[index] : val::undefined();
}

// --- construction -----------------------------------------------------------

double LuaContext::EntryCounterAddress() {
  return static_cast<double>(reinterpret_cast<uintptr_t>(&EntriesBegun()));
}

LuaContext* LuaContext::Create(const val& call) {
  ++EntriesBegun();
  js::ClearPending();
  std::unique_ptr<LuaContext> context(new LuaContext());
  context->shell_state_ = call["state"];
  try {
    context->Construct(Args(call["args"]));
  } catch (const js::JsError& e) {
    js::Throw(e.Value());
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
  }
  if (js::HasPending()) {
    js::ClearPending();
    return nullptr;
  }
  return context.release();
}

// Native: LuaContext::CreateRuntime.
bool LuaContext::CreateRuntime(ContextInitOptions& init) {
  try {
    if (init.has_max_memory || init.has_max_instructions || init.has_timeout ||
        init.seal_base_filesystem || init.strict_conversion) {
      lua_core::RuntimeConfig config;
      config.libraries = std::move(init.libraries);
      config.max_memory = init.max_memory;
      config.max_instructions = init.max_instructions;
      config.timeout_ms = init.timeout_ms;
      config.seal_base_filesystem = init.seal_base_filesystem;
      config.strict_conversion = init.strict_conversion;
      runtime_ = std::make_shared<lua_core::LuaRuntime>(config);
    } else if (init.has_libraries) {
      runtime_ = std::make_shared<lua_core::LuaRuntime>(init.libraries);
    } else {
      runtime_ = std::make_shared<lua_core::LuaRuntime>();
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return false;
  }
  return true;
}

// Native: LuaContext::ApplyFilesystemOption.
bool LuaContext::ApplyFilesystemOption(const val& options) {
  if (!js::Has(options, "filesystem")) return true;
  const val fs = js::Get(options, "filesystem");
  if (js::IsNullish(fs)) return true;
  if (!js::IsString(fs)) {
    js::ThrowTypeError("filesystem must be 'allow' or 'deny'");
    return false;
  }
  const std::string mode = js::Utf8(fs);
  if (mode == "deny") {
    filesystem_denied_ = true;
    runtime_->SetFilesystemAccess(false);
  } else if (mode != "allow") {
    js::ThrowTypeError("filesystem must be 'allow' or 'deny', got '" + mode + "'");
    return false;
  }
  return true;
}

// Native: LuaContext::ApplyTableAsOption.
bool LuaContext::ApplyTableAsOption(const val& options) {
  if (!js::Has(options, "tableAs")) return true;
  const val mode = js::Get(options, "tableAs");
  if (js::IsNullish(mode)) return true;
  if (!js::IsString(mode)) {
    js::ThrowTypeError("tableAs must be 'object' or 'map'");
    return false;
  }
  const std::string want = js::Utf8(mode);
  if (want == "map") {
    table_as_map_ = true;
    runtime_->SetPreserveTableKeys(true);
  } else if (want != "object") {
    js::ThrowTypeError("tableAs must be 'object' or 'map', got '" + want + "'");
    return false;
  }
  return true;
}

// Native: LuaContext::ApplyStateOptions.
bool LuaContext::ApplyStateOptions(const val& options, const bool sandbox_preset) {
  try {
    const bool bytecode_explicit =
      js::Has(options, "allowBytecode") && js::IsBoolean(js::Get(options, "allowBytecode"));
    const bool bytecode_wanted =
      bytecode_explicit ? js::Get(options, "allowBytecode").as<bool>() : !sandbox_preset;
    if (!bytecode_wanted) {
      allow_bytecode_ = false;
      runtime_->SetAllowBytecode(false);  // E3
    }
    if (!ApplyFilesystemOption(options)) return false;
    if (js::Has(options, "binaryStrings") && js::IsBoolean(js::Get(options, "binaryStrings")) &&
        js::Get(options, "binaryStrings").as<bool>()) {
      binary_strings_ = true;
    }
    if (!ApplyTableAsOption(options)) return false;
  } catch (const std::exception& e) {
    // Catches a JsError too, as the native handler catches a Napi::Error: an
    // option getter that throws surfaces as a fresh Error carrying its message.
    js::ThrowError(e.what());
    return false;
  }
  return true;
}

// Native: the LuaContext constructor.
void LuaContext::Construct(const Args& info) {
  const bool has_options = info.Length() > 1 && js::IsObject(info[1]);

  ContextInitOptions init;
  if (has_options && !ParseInitOptions(info[1], init)) return;
  if (!CreateRuntime(init)) return;

  InstallRuntimeHandlers();

  if (info.Length() > 0 && js::IsObject(info[0])) {
    // Retained so reset() can re-register the same callbacks on a fresh state.
    callbacks_ref_ = info[0];
    RegisterCallbacks(info[0]);
    if (js::HasPending()) return;
  }

  if (!has_options) return;
  const val options = info[1];
  if (!ApplyStateOptions(options, init.sandbox_preset)) return;

  // E1. Last of the state options, so the print override wins over any
  // callback-provided print.
  try {
    if (js::Has(options, "print") && js::IsFunction(js::Get(options, "print"))) {
      InstallPrintHandler(js::Get(options, "print"));
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return;
  }

  // Native: the constructor ends with SubscribeSharedTables. Here that is the
  // shell's second call, SubscribeShared, made once the JS object is a context.
}

namespace {

// Native: AsSharedTable. Whether `value` was minted by createSharedTable(); the
// shell answers from the class's private brand.
bool IsSharedTable(const val& value) {
  if (js::KindOf(value) != js::Kind::Object) return false;
  return js::Host().call<bool>("isSharedTable", value);
}

}  // namespace

// Native: LuaContext::SubscribeSharedTables. Subscribes this context to each
// table in the `shared` option. Last in construction because publishing goes
// through the context's own set_global. A failure leaves a JS exception
// pending, as every other constructor failure does.
void LuaContext::SubscribeSharedTables(const val& self, const val& options) {
  if (!js::Has(options, "shared")) return;
  const val shared_val = js::Get(options, "shared");
  if (js::IsNullish(shared_val)) return;
  if (js::KindOf(shared_val) != js::Kind::Object || js::IsArray(shared_val)) {
    js::ThrowTypeError("shared must be an object mapping global names to shared tables");
    return;
  }
  // A shared table handed over directly has no own enumerable keys, so it
  // would otherwise subscribe nothing at all — silently. Name the mistake.
  if (IsSharedTable(shared_val)) {
    js::ThrowTypeError(
      "shared must be an object mapping global names to shared tables "
      "(e.g. { settings: sharedTable }), not a shared table itself");
    return;
  }
  const val names = js::Keys(shared_val);
  const uint32_t count = js::Length(names);
  for (uint32_t i = 0; i < count; ++i) {
    const std::string name = js::Utf8(names[i]);
    const val entry = js::Get(shared_val, name);
    if (!IsSharedTable(entry)) {
      js::ThrowTypeError(
        "shared." + name + " must be a shared table created with createSharedTable()");
      return;
    }
    try {
      js::SharedSubscribe(entry, self, name);
    } catch (const js::JsError& e) {
      js::Throw(e.Value());
      return;
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return;
    }
    // Retained so reset() can re-publish it onto the fresh state.
    shared_tables_.emplace_back(entry, name);
  }
}

// The shell's second construction call; `info` is the constructor's arguments.
val LuaContext::SubscribeShared(const Args& info) {
  if (info.Length() > 1 && js::IsObject(info[1])) SubscribeSharedTables(Self(), info[1]);
  return val::undefined();
}

// Native: LuaContext::~LuaContext.
LuaContext::~LuaContext() {
  if (alive_) alive_->store(false);
  if (context_alive_) context_alive_->store(false);
  DetachRuntimeHandlers();
  if (runtime_) runtime_->ClearHostFunctions();
}

// Native: LuaContext::FindClassAccessor.
const ClassAccessor* LuaContext::FindClassAccessor(
    const std::string& class_name, const std::string& key) const {
  constexpr int kMaxClassDepth = 32;  // see the native header
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

// Native: LuaContext::ReadUserdataProperty. `__index` for proxy userdata and
// class instances; runs inside a Lua C frame.
lua_core::LuaPtr LuaContext::ReadUserdataProperty(const int ref_id, const std::string& key) {
  const auto it = js_userdata_.find(ref_id);
  if (it == js_userdata_.end()) {
    return std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::nil());
  }
  // Named accessors (P2b) are consulted before the readable check, and win
  // over it.
  const ClassAccessor* acc = it->second.class_name.empty()
    ? nullptr : FindClassAccessor(it->second.class_name, key);
  if (acc) {
    if (!acc->getter) {
      throw std::runtime_error(
        "property '" + key + "' of class '" + it->second.class_name +
        "' is write-only");
    }
    // Take both out before anything below can run user JS: `it` is
    // invalidated by a rehash of js_userdata_ and `acc` by a re-entrant
    // register_class (CR-11 F5 / CR-13). Neither is named again.
    const val self = it->second.object;
    const val getter = *acc->getter;
    try {
      const val result = js::CallWithThis(getter, self, {self});
      return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(result));
    } catch (const js::JsError& e) {
      throw js::MakeError(js::ThrowMessage(e));
    }
  }
  if (!it->second.readable) {
    // PropertyAccessDenied, not runtime_error: this is the access-policy
    // refusal the core is allowed to report as nil on an object with methods.
    throw lua_core::PropertyAccessDenied("userdata is not readable");
  }
  // A JsError is caught ahead of the core's generic handler so a non-Error
  // throw keeps its text (CR-18 F2).
  const val self = it->second.object;
  try {
    const val result = js::Get(self, key);
    return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(result));
  } catch (const js::JsError& e) {
    throw js::MakeError(js::ThrowMessage(e));
  }
}

// Native: LuaContext::WriteUserdataProperty. `__newindex`, the setter half.
void LuaContext::WriteUserdataProperty(const int ref_id, const std::string& key,
                                       const lua_core::LuaPtr& value) {
  const auto it = js_userdata_.find(ref_id);
  if (it == js_userdata_.end()) return;
  const ClassAccessor* acc = it->second.class_name.empty()
    ? nullptr : FindClassAccessor(it->second.class_name, key);
  if (acc) {
    if (!acc->setter) {
      throw std::runtime_error(
        "property '" + key + "' of class '" + it->second.class_name +
        "' is read-only");
    }
    // The instance and the accessor are taken out BEFORE the value is
    // converted: CoreToNapi runs the Lua->JS converters, which are user JS.
    const val self = it->second.object;
    const val setter = *acc->setter;
    try {
      js::CallWithThis(setter, self, {self, CoreToNapi(*value)});
    } catch (const js::JsError& e) {
      throw js::MakeError(js::ThrowMessage(e));
    }
    return;
  }
  if (!it->second.writable) {
    throw lua_core::PropertyAccessDenied("userdata is not writable");
  }
  // The object is taken out before CoreToNapi runs, for the reason above.
  // Natively that ordering rests on C++17's sequencing of a member call; a
  // named local says it outright.
  const val self = it->second.object;
  try {
    js::Set(self, key, CoreToNapi(*value));
  } catch (const js::JsError& e) {
    throw js::MakeError(js::ThrowMessage(e));  // see the getter (CR-18 F2)
  }
}

// Native: LuaContext::InstallRuntimeHandlers.
void LuaContext::InstallRuntimeHandlers() {
  // The core has already dropped the Lua-side method table by the time this
  // runs; drop the JS half so a short-lived userdata with methods does not pin
  // them for the life of the context (CR-11 F4).
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

  runtime_->SetHostFunctionGCCallback([this](const std::string& name) {
    js_callbacks_.erase(name);
  });

  // Property handlers for proxy userdata.
  runtime_->SetPropertyHandlers(
    [this](int ref_id, const std::string& key) -> lua_core::LuaPtr {
      return ReadUserdataProperty(ref_id, key);
    },
    [this](int ref_id, const std::string& key, const lua_core::LuaPtr& value) {
      WriteUserdataProperty(ref_id, key, value);
    }
  );
}

// Native: LuaContext::DetachRuntimeHandlers.
void LuaContext::DetachRuntimeHandlers() const {
  if (!runtime_) return;
  runtime_->SetUserdataGCCallback(nullptr);
  runtime_->SetHostFunctionGCCallback(nullptr);
  runtime_->SetPropertyHandlers(nullptr, nullptr);
  runtime_->SetOutputHandler(nullptr);
  runtime_->DropInputHandler();
  runtime_->DropFileReader();
  runtime_->RemoveDebugHook();
}

// Native: LuaContext::RegisterCallbacks.
void LuaContext::RegisterCallbacks(const val& callbacks) {
  const val keys = js::Keys(callbacks);
  const uint32_t count = js::Length(keys);

  for (uint32_t i = 0; i < count; i++) {
    const val key = keys[i];
    const val value = js::Get(callbacks, key);
    const std::string key_str = js::Utf8(key);

    try {
      if (js::IsFunction(value)) {
        // Runtime registration first: if the protected _G write throws, no
        // js_callbacks_/host_functions_ entry is left behind (N5).
        runtime_->RegisterFunction(key_str, CreateJsCallbackWrapper(key_str));
        js_callbacks_.insert_or_assign(key_str, value);
      } else {
        runtime_->SetGlobal(key_str, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value)));
      }
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return;
    }
  }
}

// Native: LuaContext::InstallPrintHandler.
void LuaContext::InstallPrintHandler(const val& fn) {
  runtime_->SetOutputHandler([this](const std::string& text) {
    if (!print_handler_) return;
    // This runs inside Lua's C call frame (print/io.write), so nothing may
    // unwind out of it. A throwing handler is swallowed; see the native
    // comment for why that is `catch (...)` and what it costs.
    try {
      const val handler = *print_handler_;
      js::Call(handler, {js::String(text)});
    } catch (...) {
      // Deliberately swallowed; see above.
    }
  });
  print_handler_ = fn;
}

// --- occupancy --------------------------------------------------------------

// Native: LuaContext::RejectIfOccupied. The ordering argument there is about a
// worker thread this target does not have; the order is kept anyway, because
// it also decides which reason the caller is told.
bool LuaContext::RejectIfOccupied(const char* op, const lua_occupancy::Claim disallowed,
                                  const char* detail) const {
  using lua_occupancy::Claim;

  if (closed_) {
    js::ThrowError(op
      ? std::string(op) + " is unavailable: the Lua context has been closed"
      : std::string("the Lua context has been closed"));
    return true;
  }
  const auto wants = [disallowed](const Claim c) {
    return lua_occupancy::Any(disallowed & c);
  };

  assert((!lua_occupancy::Any(disallowed & (Claim::LuaExecuting |
                                            Claim::BindingCall |
                                            Claim::Resetting)) ||
          wants(Claim::AsyncInFlight)) &&
         "an occupancy policy that tests any claim below AsyncInFlight must "
         "also test AsyncInFlight");

  const char* reason = nullptr;
  bool parameterized = true;
  if (wants(Claim::AsyncInFlight) && is_busy_) {
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
  js::ThrowError(message);
  return true;
}

bool LuaContext::RejectIfBusy() const {
  return RejectIfOccupied(nullptr, lua_occupancy::kSyncApi);
}

// --- errors -----------------------------------------------------------------

// Native: LuaContext::StageJsError.
std::string LuaContext::StageJsError(const val& value, const std::string& message,
                                     const lua_core::LuaRuntime* owner) {
  const bool deliverable = owner == nullptr || owner == runtime_.get();
  if (!deliverable || !js::IsObject(value)) {
    return message.empty() ? js::ToString(value) : message;
  }

  const uint64_t id = next_js_error_id_++;
  js_error_registry_.insert_or_assign(id, value);

  lua_core::LuaTable t;
  t.emplace("message",
    std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(message)));
  t.emplace(lua_core::LuaRuntime::kJsErrorIdField,
    std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(static_cast<int64_t>(id))));
  if (const val name = js::Get(value, "name"); js::IsString(name)) {
    t.emplace("name", std::make_shared<lua_core::LuaValue>(
      lua_core::LuaValue::from(js::Utf8(name))));
  }
  if (const val stack = js::Get(value, "stack"); js::IsString(stack)) {
    t.emplace("stack", std::make_shared<lua_core::LuaValue>(
      lua_core::LuaValue::from(js::Utf8(stack))));
  }
  runtime_->SetPendingErrorValue(
    std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(std::move(t))));
  return message;
}

// Native: LuaContext::LuaErrorToJsValue.
val LuaContext::LuaErrorToJsValue(const std::string& fallback) {
  const lua_core::LuaPtr ev = runtime_->TakeLastErrorValue();
  if (ev && std::holds_alternative<lua_core::LuaTable>(ev->value)) {
    const auto& t = std::get<lua_core::LuaTable>(ev->value);
    const auto it = t.find(lua_core::LuaRuntime::kJsErrorIdField);
    if (it != t.end() && it->second &&
        std::holds_alternative<int64_t>(it->second->value)) {
      const int64_t raw = std::get<int64_t>(it->second->value);
      const auto rit = raw < 0 ? js_error_registry_.end()
                         : js_error_registry_.find(static_cast<uint64_t>(raw));
      if (rit != js_error_registry_.end()) {
        val original = rit->second;
        js_error_registry_.erase(rit);
        return original;  // the original JS Error object, fully preserved
      }
    }
  }
  return js::NewErrorValue(fallback);
}

void LuaContext::ThrowLuaError(const std::string& fallback) {
  js::Throw(LuaErrorToJsValue(fallback));
}

// Native: LuaContext::CreateJsCallbackWrapper.
lua_core::LuaRuntime::Function LuaContext::CreateJsCallbackWrapper(const std::string& name) {
  return [this, name, alive = context_alive_, owner = runtime_.get()](
           const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
    if (!alive || !alive->load()) {
      throw std::runtime_error(
        "JS callback '" + name + "' outlived its Lua context");
    }
    const auto cb_it = js_callbacks_.find(name);
    if (cb_it == js_callbacks_.end()) {
      throw std::runtime_error("JS callback '" + name + "' is no longer registered");
    }
    // Take the function out of the map before any user JS runs: a nested
    // registration can rehash js_callbacks_ (CR-11 F5).
    const val callback = cb_it->second;
    std::vector<val> js_args;
    js_args.reserve(args.size());
    for (const auto& a : args) {
      js_args.push_back(CoreToNapi(*a));
    }
    try {
      const val result = js::Call(callback, js_args);
      if (js::IsPromise(result)) {
        if (!runtime_->IsAwaitDriverMode()) {
          throw std::runtime_error(
            "'" + name + "' returned a Promise; call it inside execute_async(), "
            "call_async(), or resume_async() to await it");
        }
        // Stash the promise and signal LuaCallHostFunction to suspend.
        async_pending_promise_ = result;
        runtime_->RequestAwaitYield();
        return std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::nil());
      }
      return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(result));
    } catch (const js::JsError& e) {
      throw std::runtime_error(StageJsError(e.Value(), js::ThrowMessage(e), owner));
    }
  };
}

// Native: LuaContext::CreateConstructorWrapper.
lua_core::LuaRuntime::Function LuaContext::CreateConstructorWrapper(
    const std::string& name, const std::string& class_name,
    const bool readable, const bool writable) {
  return [this, name, class_name, readable, writable, alive = context_alive_,
          owner = runtime_.get()](
      const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
    if (!alive || !alive->load()) {
      throw std::runtime_error(
        "class '" + class_name + "' constructor outlived its Lua context");
    }
    const auto cb_it = js_callbacks_.find(name);
    if (cb_it == js_callbacks_.end()) {
      throw std::runtime_error(
        "Class '" + class_name + "' constructor is no longer registered");
    }
    // Take the function out of the map before any user JS runs (CR-11 F5).
    const val callback = cb_it->second;
    std::vector<val> js_args;
    js_args.reserve(args.size());
    for (const auto& a : args) {
      js_args.push_back(CoreToNapi(*a));
    }

    val instance = val::undefined();
    try {
      instance = js::Call(callback, js_args);
    } catch (const js::JsError& e) {
      throw std::runtime_error(StageJsError(e.Value(), js::ThrowMessage(e), owner));
    }

    if (js::KindOf(instance) != js::Kind::Object || js::IsArray(instance)) {
      throw std::runtime_error(
        "Class '" + class_name + "' constructor must return an object");
    }

    // Register the new instance as JS-backed userdata, and tag it so that
    // passing the JS object back into Lua re-materializes it as the same class
    // userdata instead of deep-copying it. Two owner markers, and the *id* is
    // the load-bearing one (CR-14 F2); the owner object stays because a genuine
    // one cannot be minted from JS.
    const int ref_id = NextUserdataId();
    const val runtime_id(runtime_->Id());  // a BigInt
    js::DefineHidden(instance, "__luaClassRef", val(ref_id));
    js::DefineHidden(instance, "__luaClassName", js::String(class_name));
    js::DefineHidden(instance, "__luaClassOwner",
                     js::Host().call<val>("runtimeOwner", runtime_id));
    js::DefineHidden(instance, "__luaClassOwnerId", runtime_id);

    UserdataEntry entry;
    entry.object = instance;
    entry.readable = readable;
    entry.writable = writable;
    // The link the property handlers need to reach this class's named
    // accessors (P2b).
    entry.class_name = class_name;
    js_userdata_.insert_or_assign(ref_id, std::move(entry));

    // A class-bound userdata reference; PushLuaValue materializes it with the
    // per-class metatable.
    return std::make_shared<lua_core::LuaValue>(
      lua_core::LuaValue::from(lua_core::LuaUserdataRef(
        ref_id, runtime_->RawState(), /*is_opaque=*/false, LUA_NOREF,
        /*is_proxy=*/false, class_name)));
  };
}

// Native: LuaContext::NextUserdataId.
int LuaContext::NextUserdataId() {
  if (next_userdata_id_ == std::numeric_limits<int>::max()) {
    throw std::runtime_error(
      "userdata id space exhausted on this context (2^31 registrations); "
      "create a new context");
  }
  return next_userdata_id_++;
}

// --- entry points -----------------------------------------------------------

// Native: LuaContext::ExecuteScript.
val LuaContext::ExecuteScript(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string argument");
    return val::undefined();
  }

  const std::string script = js::Utf8(info[0]);

  const CallScope call_scope(this);
  std::string chunk_name;
  if (!ParseChunkName(info, 1, "execute_script()", chunk_name)) return val::undefined();

  const auto res = runtime_->ExecuteScript(script, chunk_name);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return val::undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

// Native: LuaContext::SetGlobal.
val LuaContext::SetGlobal(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 2 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string name as first argument");
    return val::undefined();
  }

  const std::string name = js::Utf8(info[0]);

  // A metatabled _G runs its __newindex here (CR-9 F1).
  const CallScope call_scope(this);

  // A dotted name addresses a nested field, creating missing intermediate
  // tables. Functions take the reclaimable nested-closure path.
  if (name.find('.') != std::string::npos) {
    std::vector<std::string> path;
    if (!SplitGlobalPath(name, path)) {
      js::ThrowTypeError("Invalid global path '" + name +
        "': path segments must be non-empty (no leading, trailing, or doubled dots)");
      return val::undefined();
    }
    try {
      runtime_->SetGlobalPath(
        path, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[1])));
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
    }
    return val::undefined();
  }

  try {
    if (const val value = info[1]; js::IsFunction(value)) {
      // Runtime registration first: if the protected _G write throws, no
      // js_callbacks_/host_functions_ entry is left behind (N5).
      runtime_->RegisterFunction(name, CreateJsCallbackWrapper(name));
      js_callbacks_.insert_or_assign(name, value);
    } else {
      runtime_->SetGlobal(name, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value)));
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  return val::undefined();
}

// Native: LuaContext::GetGlobal.
val LuaContext::GetGlobal(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string name as first argument");
    return val::undefined();
  }

  const std::string name = js::Utf8(info[0]);

  // See SetGlobal: a metatabled _G runs its __index here (CR-9 F1).
  const CallScope call_scope(this);

  // A dotted name reads a nested field; a nil anywhere along the path yields
  // null.
  if (name.find('.') != std::string::npos) {
    std::vector<std::string> path;
    if (!SplitGlobalPath(name, path)) {
      js::ThrowTypeError("Invalid global path '" + name +
        "': path segments must be non-empty (no leading, trailing, or doubled dots)");
      return val::undefined();
    }
    try {
      const auto result = runtime_->GetGlobalPath(path);
      return CoreToNapi(*result);
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return val::undefined();
    }
  }

  try {
    const auto result = runtime_->GetGlobal(name);
    return CoreToNapi(*result);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
}

// Native: LuaContext::Call. call(name, ...args) — invoke a Lua function by
// global name without minting a JS wrapper for it.
val LuaContext::Call(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("call(name, ...args) requires a string name");
    return val::undefined();
  }

  const std::string name = js::Utf8(info[0]);

  // Opened *above* the lookup, not after it: resolving `name` can run a
  // metatabled _G's __index before the call itself begins (CR-9 F1).
  const CallScope scope(this);

  lua_core::LuaPtr target;
  try {
    if (name.find('.') != std::string::npos) {
      std::vector<std::string> path;
      if (!SplitGlobalPath(name, path)) {
        js::ThrowTypeError("Invalid global path '" + name +
          "': path segments must be non-empty (no leading, trailing, or doubled dots)");
        return val::undefined();
      }
      target = runtime_->GetGlobalPath(path);
    } else {
      target = runtime_->GetGlobal(name);
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  // Only a genuine Lua function is accepted; a callable table arrives as a
  // LuaTableRef.
  if (!target || !std::holds_alternative<lua_core::LuaFunctionRef>(target->value)) {
    js::ThrowTypeError("Lua global '" + name + "' is not a function");
    return val::undefined();
  }

  // One collector spans every argument so a later argument's conversion failure
  // sweeps the reclaimable callbacks minted by the earlier ones (CR-8 F1).
  const JsCallbackCollectorScope collector(this);
  std::vector<lua_core::LuaPtr> args;
  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  try {
    for (uint32_t i = 1; i < info.Length(); ++i) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[i])));
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  const auto result =
    runtime_->CallFunction(std::get<lua_core::LuaFunctionRef>(target->value), args);
  if (std::holds_alternative<std::string>(result)) {
    ThrowLuaError(std::get<std::string>(result));
    return val::undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result));
}

// Native: LuaContext::Pcall.
val LuaContext::Pcall(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsFunction(info[0])) {
    js::ThrowTypeError("pcall(fn, ...args) requires a function as the first argument");
    return val::undefined();
  }

  const val fn = info[0];
  std::vector<val> args;
  for (uint32_t i = 1; i < info.Length(); ++i) args.push_back(info[i]);

  val result = val::object();
  try {
    const val r = js::Call(fn, args);
    js::Set(result, "ok", val(true));
    js::Set(result, "value", r);
  } catch (const js::JsError& e) {
    // The thrown value is preserved (the original JS Error when the failure
    // came from a JS callback; otherwise a Lua-error Error object).
    js::Set(result, "ok", val(false));
    js::Set(result, "error", e.Value());
  }
  return result;
}

// Native: LuaContext::CreateTableHandle. The table handle object — its
// `_tableRef` owner, its nine methods and its iterator — is built by the shell;
// the unique_ptr holds the ref until the shell's handle is the owner (CR-9 F4).
val LuaContext::CreateTableHandle(const int registry_ref) {
  auto data = std::make_unique<LuaTableRefData>(
    runtime_, lua_core::LuaTableRef(registry_ref, runtime_->RawState()), this, Liveness());
  LuaTableRefData* data_ptr = data.get();
  val handle = js::Host().call<val>("tableHandle", val(data_ptr, emscripten::allow_raw_pointers()),
                                    shell_state_);
  // NOLINTNEXTLINE(bugprone-unused-return-value): the shell's handle owns it now
  (void)data.release();
  return handle;
}

// Native: LuaContext::CreateTableMethod.
val LuaContext::CreateTableMethod(const Args& info) {
  if (RejectIfBusy()) return val::undefined();

  int ref = LUA_NOREF;
  // One collector spans the element loop and CreateTableFrom so a failure part
  // way through sweeps the reclaimable callbacks minted by the elements
  // already converted (F1). The CallScope covers the user JS a registered type
  // converter can run during conversion (CR-9 F1).
  const CallScope call_scope(this);
  const JsCallbackCollectorScope collector(this);
  if (info.Length() > 0 && !js::IsNullish(info[0])) {
    try {
      if (js::IsArray(info[0])) {
        const val arr = info[0];
        lua_core::LuaArray lua_arr;
        lua_arr.reserve(js::Get(arr, "length").as<uint32_t>());
        for (uint32_t i = 0; i < js::Get(arr, "length").as<uint32_t>(); ++i) {
          lua_arr.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(js::GetIndex(arr, i))));
        }
        ref = runtime_->CreateTableFrom(lua_arr);
      } else if (js::IsObject(info[0])) {
        const val obj = info[0];
        lua_core::LuaTable lua_tbl;
        const val keys = js::Keys(obj);
        const uint32_t count = js::Length(keys);
        for (uint32_t i = 0; i < count; ++i) {
          const std::string key = js::Utf8(keys[i]);
          lua_tbl[key] = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(js::Get(obj, key)));
        }
        ref = runtime_->CreateTableFrom(lua_tbl);
      } else {
        js::ThrowTypeError("create_table() argument must be an object or array");
        return val::undefined();
      }
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return val::undefined();
    }
  } else {
    try {
      ref = runtime_->CreateTable();
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return val::undefined();
    }
  }

  return CreateTableHandle(ref);
}

// Native: LuaContext::GetGlobalRef.
val LuaContext::GetGlobalRef(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("get_global_ref() requires a string name");
    return val::undefined();
  }

  const std::string name = js::Utf8(info[0]);
  // The read goes through the protected-get path, and a __index on _G is Lua
  // that can reach a host callback, so it is scoped (CR-9 F1).
  std::variant<int, std::string> result;
  try {
    const CallScope call_scope(this);
    result = runtime_->GetGlobalRef(name);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  if (const auto* error = std::get_if<std::string>(&result)) {
    js::ThrowError(*error);
    return val::undefined();
  }

  const int ref = std::get<int>(result);
  return CreateTableHandle(ref);
}

// Native: LuaContext::CreateEnvironment.
val LuaContext::CreateEnvironment(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // At entry, above the options / whitelist-array reads below: both can be
  // Proxy-trapped or accessor-backed (CR-13 F1).
  const CallScope call_scope(this);

  std::vector<std::string> whitelist;
  bool inherit = false;

  if (info.Length() > 0 && !js::IsNullish(info[0]) &&
      !ReadEnvironmentOptions(info[0], whitelist, inherit)) {
    return val::undefined();
  }

  int ref = LUA_NOREF;
  try {
    // Reading a whitelisted name can fire an __index on _G that re-enters JS;
    // the method-entry scope above covers it (CR-14 F5).
    ref = runtime_->CreateEnvironment(whitelist, inherit);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  return CreateTableHandle(ref);
}

// Native: LuaContext::ExecuteScriptIn.
val LuaContext::ExecuteScriptIn(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 2 || !js::IsString(info[1])) {
    js::ThrowTypeError("execute_script_in(env, script) requires an environment and a script string");
    return val::undefined();
  }

  const auto* data = TableRefDataFrom(info[0]);
  if (!data) {
    js::ThrowTypeError(
      "execute_script_in(): the first argument must be an environment or table reference");
    return val::undefined();
  }
  // Same policy as release() and the round-trip markers: a ref index minted by
  // another context (or by this one before a reset()) addresses an unrelated
  // slot in the current registry.
  if (data->runtime.get() != runtime_.get()) {
    js::ThrowError("environment belongs to a different Lua context");
    return val::undefined();
  }
  if (data->table_ref.ref == LUA_NOREF) {
    js::ThrowError("table handle has been released");
    return val::undefined();
  }

  const std::string script = js::Utf8(info[1]);

  const CallScope call_scope(this);
  std::string chunk_name;
  if (!ParseChunkName(info, 2, "execute_script_in()", chunk_name)) return val::undefined();

  const auto res = runtime_->ExecuteScriptInEnvironment(data->table_ref.ref, script, chunk_name);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return val::undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

// --- userdata ---------------------------------------------------------------

// Native: LuaContext::RegisterUserdataMethods. Called inside SetUserdata's try:
// both core calls throw on OOM. Every name is appended to
// `registered_method_fns` as it is minted, so the rollback sees what exists.
void LuaContext::RegisterUserdataMethods(
    const int ref_id, const FunctionList& method_funcs,
    std::vector<std::string>& registered_method_fns) {
  std::unordered_map<std::string, std::string> method_map;

  for (const auto& [method_name, method_func] : method_funcs) {
    const std::string func_name = "__ud_method_" + std::to_string(ref_id)
                          + "_" + method_name;

    // Record the name before registering the pair, so the rollback always
    // sees it (CR-8 F7).
    registered_method_fns.push_back(func_name);
    js_callbacks_.insert_or_assign(func_name, method_func);
    runtime_->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
    method_map[method_name] = func_name;
  }

  runtime_->SetUserdataMethodTable(ref_id, method_map);
  // Recorded only once the whole build succeeded; from here the userdata's own
  // __gc owns their lifetime (CR-11 F4).
  ud_method_fns_[ref_id] = registered_method_fns;
}

// Native: LuaContext::RollBackUserdata. Undoes a set_userdata that failed
// part-way, so a rejected call strands nothing.
void LuaContext::RollBackUserdata(const std::string& name, const int ref_id,
                                  const std::vector<std::string>& registered_method_fns,
                                  const bool global_installed) {
  js_userdata_.erase(ref_id);
  for (const auto& func_name : registered_method_fns) {
    js_callbacks_.erase(func_name);
    runtime_->RemoveHostFunction(func_name);
  }
  // Only when this call installed the global — a pre-existing same-named one
  // must not be deleted (CR-7 F3). Raw and best-effort.
  if (!global_installed) return;
  try {
    runtime_->RemoveGlobalRaw(name);
  } catch (...) {
    // Best-effort; see the native comment.
  }
}

// Native: LuaContext::SetUserdata.
val LuaContext::SetUserdata(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // At entry, above the options / methods property reads below — any of which
  // can be a getter that re-enters this context (CR-13 F1).
  const CallScope call_scope(this);
  if (info.Length() < 2 || !js::IsString(info[0]) || !js::IsObject(info[1])) {
    js::ThrowTypeError("Expected (string, object[, options])");
    return val::undefined();
  }

  const std::string name = js::Utf8(info[0]);

  bool readable = false;
  bool writable = false;
  bool has_methods = false;

  // Held until they can be registered.
  FunctionList method_funcs;

  if (info.Length() >= 3 && js::IsObject(info[2])) {
    ReadUserdataOptions(info[2], readable, writable, method_funcs);
    has_methods = !method_funcs.empty();
  }

  int ref_id = 0;
  try {
    ref_id = NextUserdataId();
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  UserdataEntry entry;
  entry.object = info[1];
  entry.readable = readable;
  entry.writable = writable;
  js_userdata_.insert_or_assign(ref_id, std::move(entry));

  // The core calls below build inside RunProtected, which throws on OOM under
  // maxMemory or a raising __newindex on a _G metatable at the global write
  // (CR-6 F1). On failure, roll back what was registered above.
  std::vector<std::string> registered_method_fns;
  bool global_installed = false;
  try {
    if (readable || writable || has_methods) {
      runtime_->CreateProxyUserdataGlobal(name, ref_id);
    } else {
      runtime_->CreateUserdataGlobal(name, ref_id);
    }
    global_installed = true;

    if (has_methods) RegisterUserdataMethods(ref_id, method_funcs, registered_method_fns);
  } catch (const std::exception& e) {
    RollBackUserdata(name, ref_id, registered_method_fns, global_installed);
    js::ThrowError(e.what());
    return val::undefined();
  }

  return val::undefined();
}

// --- classes ----------------------------------------------------------------

// Native: LuaContext::BuildClassStatics. Functions become host-function
// closures on the class table; other values are converted once, here. Returns
// false with a JS exception pending; nothing is registered yet at that point.
bool LuaContext::BuildClassStatics(
    const uint64_t class_id, const FunctionList& static_fn_snapshot,
    const FunctionList& static_val_snapshot, FunctionList& deferred_fns,
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
  for (const auto& [key, value] : static_val_snapshot) {
    lua_core::MetatableEntry entry;
    entry.key = key;
    entry.is_function = false;
    try {
      entry.value = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value));
    } catch (const js::JsError& e) {
      // Conversion runs user JS (a converter, a Proxy trap) and can throw.
      js::Throw(e.Value());
      return false;
    } catch (const std::exception& e) {
      js::ThrowError("register_class(): static '" + key + "': " + e.what());
      return false;
    }
    statics.push_back(std::move(entry));
  }
  return true;
}

// Native: LuaContext::RegisterClass.
val LuaContext::RegisterClass(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // At entry, above every read of `def` below: each can run a hostile getter
  // or Proxy trap (N3), and one that called reset() used to succeed (CR-13 F1).
  const CallScope call_scope(this);
  if (info.Length() < 2 || !js::IsString(info[0]) || !js::IsObject(info[1])) {
    js::ThrowTypeError("register_class(name, definition) requires a string name and an object");
    return val::undefined();
  }

  const std::string class_name = js::Utf8(info[0]);
  const val def = info[1];

  // Reject a duplicate class name before any callback is registered (L7). The
  // binding's own ledger is the authority, not the core's registry (CR-12 F5).
  if (registered_classes_.count(class_name) != 0) {
    js::ThrowError("class '" + class_name + "' is already registered on this context");
    return val::undefined();
  }

  // Reserve the name *before* reading any property off `def`: a reentrant
  // register_class(sameName) from a getter would otherwise pass the check
  // above (F5). The guard rolls the reservation back on every failure exit.
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

  // Each property is read exactly once, into a local (N3).
  const val construct_fn = js::Get(def, "construct");
  if (!js::IsFunction(construct_fn)) {
    js::ThrowTypeError("register_class() definition requires a 'construct' function");
    return val::undefined();
  }

  std::string parent_class;
  if (!ReadClassExtends(def, class_name, registered_classes_, parent_class)) {
    return val::undefined();
  }

  FunctionList mm_snapshot;
  if (!ReadClassMetamethods(def, mm_snapshot)) return val::undefined();

  FunctionList static_fn_snapshot;
  FunctionList static_val_snapshot;
  if (!ReadClassStatics(def, static_fn_snapshot, static_val_snapshot)) {
    return val::undefined();
  }

  ClassAccessorTable accessors;
  accessors.parent = parent_class;
  if (!ReadClassProperties(def, accessors)) return val::undefined();

  const val readable_val = js::Get(def, "readable");
  const val writable_val = js::Get(def, "writable");
  const bool readable = js::IsBoolean(readable_val) && readable_val.as<bool>();
  const bool writable = js::IsBoolean(writable_val) && writable_val.as<bool>();

  const uint64_t class_id = next_class_id_++;

  // Names are minted and the JS functions collected here, but nothing is
  // registered into js_callbacks_/host_functions_ until the core call below
  // succeeds (CR-8 F3, and the N5 / CR-7 F4 ordering discipline).
  const std::string ctor_name = "__class_ctor_" + std::to_string(class_id);

  std::unordered_map<std::string, std::string> method_map;
  FunctionList deferred_fns;
  ReadClassMethods(def, class_id, method_map, deferred_fns);

  // Metamethods, taken from the snapshot validated above (N3).
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
    return val::undefined();
  }

  // RegisterClass builds inside RunProtected, which throws on OOM or a raising
  // __newindex on a _G metatable at the class-global write (the H1 class).
  try {
    runtime_->RegisterClass(class_name, ctor_name, method_map, metamethods,
                           parent_class, statics);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    // The reservation guard releases the name; nothing was registered (CR-8 F3).
    return val::undefined();
  }

  // Deliberately NOT reserved as reclaimable (CR-11 F4): a class registration
  // cannot be superseded, so its constructor and methods are permanent.
  js_callbacks_.insert_or_assign(ctor_name, construct_fn);
  runtime_->StoreHostFunction(ctor_name,
    CreateConstructorWrapper(ctor_name, class_name, readable, writable));
  for (const auto& [func_name, fn] : deferred_fns) {
    js_callbacks_.insert_or_assign(func_name, fn);
    runtime_->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }
  // Accessors go in with the rest, after the core build succeeded.
  if (!accessors.props.empty() || !accessors.parent.empty()) {
    class_accessors_.emplace(class_name, std::move(accessors));
  }

  reservation.Commit();
  return val::undefined();
}

// --- metatables -------------------------------------------------------------

// Native: LuaContext::ReserveDeferredCallbacks. Marks each deferred name
// reclaimable and hands it to the active collector (CR-11 F4).
void LuaContext::ReserveDeferredCallbacks(const FunctionList& deferred) const {
  for (const auto& [func_name, fn] : deferred) {
    runtime_->ReserveReclaimableHostFunction(func_name);
    if (js_callback_collector_) js_callback_collector_->push_back(func_name);
  }
}

// Native: LuaContext::SetMetatable. `target` is a global name or a live table
// reference — a handle, or the Proxy a metatabled table round-trips as (F1).
val LuaContext::SetMetatable(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // At entry, above the reads of the definition object below (CR-13 F1).
  const CallScope call_scope(this);

  // Resolve the target before touching the metatable definition, so a bad
  // target is rejected without minting any callback names.
  const bool by_name = info.Length() >= 1 && js::IsString(info[0]);
  const LuaTableRefData* target_ref =
      info.Length() >= 1 && !by_name ? TableRefDataFrom(info[0]) : nullptr;
  std::string name;
  if (by_name) {
    name = js::Utf8(info[0]);
  } else if (target_ref) {
    if (target_ref->runtime.get() != runtime_.get()) {
      js::ThrowError("table handle belongs to a different Lua context");
      return val::undefined();
    }
    if (target_ref->table_ref.ref == LUA_NOREF) {
      js::ThrowError("table handle has been released");
      return val::undefined();
    }
  } else {
    js::ThrowTypeError(
      "set_metatable(target, metatable) requires a global name or a table handle");
    return val::undefined();
  }

  if (info.Length() < 2 || js::KindOf(info[1]) != js::Kind::Object) {
    js::ThrowTypeError("set_metatable(): metatable must be an object");
    return val::undefined();
  }

  const val mt = info[1];
  const val keys = js::Keys(mt);
  const uint32_t count = js::Length(keys);

  const uint64_t mt_id = next_metatable_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  // One collector spans the whole entry build and the core call (CR-8 F1).
  const JsCallbackCollectorScope collector(this);

  // Function-valued entries are collected here and registered only AFTER the
  // core call succeeds (CR-8 F3).
  FunctionList deferred_fns;

  for (uint32_t i = 0; i < count; i++) {
    const std::string key = js::Utf8(keys[i]);
    const val value = js::Get(mt, key);

    lua_core::MetatableEntry entry;
    entry.key = key;

    if (js::IsFunction(value)) {
      const std::string func_name = "__mt_" + std::to_string(mt_id) + "_" + key;
      deferred_fns.emplace_back(func_name, value);
      entry.is_function = true;
      entry.func_name = func_name;
    } else {
      entry.is_function = false;
      try {
        entry.value = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value));
      } catch (const std::exception& e) {
        js::ThrowError(e.what());
        return val::undefined();
      }
    }

    entries.push_back(std::move(entry));
  }

  // Reserve the names as reclaimable *before* the core call, so the closures it
  // builds carry the reclaim sentinel (CR-11 F4).
  ReserveDeferredCallbacks(deferred_fns);

  try {
    if (target_ref) {
      runtime_->SetTableRefMetatable(target_ref->table_ref.ref, entries);
    } else {
      runtime_->SetGlobalMetatable(name, entries);
    }
  } catch (const std::runtime_error& e) {
    js::ThrowError(e.what());
    return val::undefined();  // nothing registered, nothing stranded (CR-8 F3)
  }

  for (const auto& [func_name, fn] : deferred_fns) {
    js_callbacks_.insert_or_assign(func_name, fn);
    runtime_->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }

  return val::undefined();
}

// --- converters -------------------------------------------------------------

// Native: LuaContext::RegisterTypeConverter.
val LuaContext::RegisterTypeConverter(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 2 || !js::IsFunction(info[0]) || !js::IsFunction(info[1])) {
    js::ThrowTypeError("register_type_converter(match, convert) requires two functions");
    return val::undefined();
  }
  type_converters_.emplace_back(info[0], info[1]);
  return val::undefined();
}

// Native: LuaContext::RegisterFromLuaConverter. B3 — the Lua->JS half.
val LuaContext::RegisterFromLuaConverter(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 2 || !js::IsFunction(info[0]) || !js::IsFunction(info[1])) {
    js::ThrowTypeError("register_from_lua_converter(match, convert) requires two functions");
    return val::undefined();
  }
  from_lua_converters_.emplace_back(info[0], info[1]);
  return val::undefined();
}

// --- files ------------------------------------------------------------------

// Native: LuaContext::ExecuteFile.
val LuaContext::ExecuteFile(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string argument");
    return val::undefined();
  }

  const std::string filepath = js::Utf8(info[0]);

  const CallScope call_scope(this);
  const auto res = runtime_->ExecuteFile(filepath);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return val::undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

// --- the two doors that natively run on a worker thread (plan, D3) ----------

val LuaContext::Self() const { return js::Host().call<val>("contextSelf", shell_state_); }

// Native: LuaContext::IsBusyMethod.
// NOLINTNEXTLINE(readability-make-member-function-const)
val LuaContext::IsBusyMethod(const Args& /*info*/) { return val(is_busy_.load()); }

// Native: LuaContext::ClearBusy. A deferred run's teardown; clears any cancel
// signalled during the run so it cannot abort the next one (L8).
void LuaContext::ClearBusy() {
  runtime_->ClearCancel();
  is_busy_ = false;
}

// Native: `new Lua…AsyncWorker(…)` followed by `worker->Queue()`.
void LuaContext::ScheduleWorkerRun(const bool is_file, std::string source,
                                   std::string chunk_name, const Deferred& deferred) {
  auto run = std::make_unique<LuaWorkerRun>(LuaWorkerRun{
    runtime_, is_file, std::move(source), std::move(chunk_name), this, Self(), deferred,
    false, nullptr, {}, std::nullopt});
  js::Host().call<void>("schedule", val(run.get(), emscripten::allow_raw_pointers()),
                        shell_state_, deferred.Record());
  // NOLINTNEXTLINE(bugprone-unused-return-value): the shell deletes it after the run
  (void)run.release();
}

// Native: LuaContext::ExecuteScriptAsync. The script cannot call back into JS
// and print redirection is bypassed, as on a worker; what differs is only that
// this thread is the one that runs it (plan, D3).
val LuaContext::ExecuteScriptAsync(const Args& info) {
  if (RejectIfOccupied("execute_script_async()", lua_occupancy::kExclusive,
                       kWorkerHandoffDetail)) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string argument");
    return val::undefined();
  }

  const std::string script = js::Utf8(info[0]);

  // Read before is_busy_ is set: the options read can be an accessor, and a
  // throw from it must leave the context idle rather than wedged busy.
  std::string chunk_name;
  {
    const CallScope call_scope(this);
    if (!ParseChunkName(info, 1, "execute_script_async()", chunk_name)) return val::undefined();
  }
  is_busy_ = true;

  const Deferred deferred = Deferred::New();
  ScheduleWorkerRun(/*is_file=*/false, script, chunk_name, deferred);
  return deferred.Promise();
}

// Native: LuaContext::ExecuteFileAsync.
val LuaContext::ExecuteFileAsync(const Args& info) {
  if (RejectIfOccupied("execute_file_async()", lua_occupancy::kExclusive,
                       kWorkerHandoffDetail)) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string argument");
    return val::undefined();
  }

  const std::string filepath = js::Utf8(info[0]);
  is_busy_ = true;

  const Deferred deferred = Deferred::New();
  ScheduleWorkerRun(/*is_file=*/true, filepath, "", deferred);
  return deferred.Promise();
}

// --- coroutine-driven async execution (execute_async / cancel) --------------

// Native: LuaContext::ExecuteAsync.
val LuaContext::ExecuteAsync(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string argument");
    return val::undefined();
  }

  const std::string script = js::Utf8(info[0]);

  // CreateCoroutineFromScript can throw if creating the coroutine thread OOMs
  // under maxMemory (M5); reject rather than let it unwind.
  std::variant<lua_core::LuaThreadRef, std::string> co = std::string();
  try {
    // Scoped to the load alone, and deliberately not across the DriveAsync
    // below (CR-10 F1).
    const CallScope call_scope(this);
    std::string chunk_name;
    if (!ParseChunkName(info, 1, "execute_async()", chunk_name)) return val::undefined();
    co = runtime_->CreateCoroutineFromScript(script, chunk_name);
  } catch (const std::exception& e) {
    return RejectedPromise(e.what());
  }
  if (std::holds_alternative<std::string>(co)) {
    // Reject (rather than throw) so `.catch` and `await` both see the error.
    return RejectedPromise(std::get<std::string>(co));
  }

  // The commit-point check (see BeginAsyncRun): the chunkName read above can be
  // an accessor, and a run it started must not be overwritten by this one. The
  // thread just created is dropped with `co`.
  if (IsBusy()) return RejectedPromise(kAsyncBusyMessage);

  // Binding-owned thread: created for this run, released by FinishAsync.
  async_co_.emplace(std::move(std::get<lua_core::LuaThreadRef>(co)));
  // Initial resume takes no arguments — a chunk has no parameters.
  return BeginAsyncRun(Self(), {});
}

// Native: LuaContext::AsyncDrivenThread.
const lua_core::LuaThreadRef& LuaContext::AsyncDrivenThread() const {
  return async_co_ ? *async_co_ : async_borrowed_->thread_ref;
}

// Native: LuaContext::BeginAsyncRun. Arm the await driver on the driven thread
// and take the first step. Shared by every door that runs Lua on the driver,
// so the doors cannot drift apart in what they arm.
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
// and rejects with kAsyncBusyMessage. Fixed natively on November 24, 2026 —
// found by this port's diff — and ported here the same day.
val LuaContext::BeginAsyncRun(const val& self, const std::vector<lua_core::LuaPtr>& args,
                              const char* arg_role) {
  assert(!async_deferred_.has_value() && !is_busy_ &&
         "BeginAsyncRun over a run in flight: the door skipped its "
         "commit-point check");
  is_busy_ = true;
  ++async_generation_;  // invalidate any stale settlement from a prior run
  js_error_registry_.clear();
  runtime_->ClearCancel();
  runtime_->SetAwaitDriverMode(true);
  // Tell the core which thread is the driver, so a promise awaited from a
  // coroutine this run is *not* driving is rejected (M1).
  runtime_->SetAwaitDriverThread(AsyncDrivenThread().thread);
  async_deferred_.emplace(Deferred::New());
  // Root the context's JS object for the run's duration: while the coroutine
  // is suspended, the settlement callbacks hold only a raw pointer to this.
  async_self_ref_ = self;
  // See "foreign exceptions" in shell.js: the shell rejects this if the
  // context is unwound with the run still in flight.
  shell_state_.set("run", async_deferred_->Record());

  const val promise = async_deferred_->Promise();
  // The opening step, so `arg_role` describes what the *caller* handed over
  // (CR-23 F5).
  DriveAsync(args, false, arg_role);
  return promise;
}

// Native: LuaContext::ResolveAsyncCallTarget. Three outcomes: a function;
// nullopt with `reject_reason` set; or nullopt with `threw` set and a JS
// exception pending.
std::optional<lua_core::LuaFunctionRef> LuaContext::ResolveAsyncCallTarget(
    const val& target_arg, std::string& reject_reason, bool& threw) {
  if (js::IsFunction(target_arg)) {
    // Same identity checks create_coroutine and resume apply (M1).
    const auto* fn_data = LuaFunctionDataFrom(target_arg);
    if (!fn_data) {
      js::ThrowTypeError(
        "call_async() accepts a global name or a Lua function; a plain "
        "JavaScript function is not callable in Lua");
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
    // Copying shares the registry slot rather than minting a second owner.
    return fn_data->func_ref;
  }

  const std::string name = js::Utf8(target_arg);
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
  // Only a genuine Lua function — the same line call() draws.
  if (!target || !std::holds_alternative<lua_core::LuaFunctionRef>(target->value)) {
    reject_reason = "Lua global '" + name + "' is not a function";
    return std::nullopt;
  }
  return std::get<lua_core::LuaFunctionRef>(target->value);
}

// Native: LuaContext::CallAsync. call_async(nameOrFn, ...args) — P1a.
val LuaContext::CallAsync(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || (!js::IsString(info[0]) && !js::IsFunction(info[0]))) {
    js::ThrowTypeError("call_async(nameOrFn, ...args) requires a global name or a Lua function");
    return val::undefined();
  }

  // Rejections rather than throws for everything past argument validation.
  //
  // One scope over every step that can run user JS — the marker read, the
  // global lookup, the argument conversion and the coroutine creation — and
  // closed before the drive below (CR-10 F1, CR-13 F1).
  std::optional<lua_core::LuaThreadRef> thread;
  std::vector<lua_core::LuaPtr> args;
  // One collector spans every argument so a later argument's conversion failure
  // sweeps the reclaimable callbacks minted by the earlier ones (CR-8 F1) —
  // **and stays open across the drive at the bottom**, because that is where
  // the arguments are pushed: BeginAsyncRun's first ResumeAsyncStep. Its sweep
  // erases every callback not yet pushed, so closed any earlier it erases all
  // of them, and a function argument reached Lua as a name that resolved to
  // nothing. Unlike the CallScope below it is safe to hold: it raises no depth
  // counter, and the drive returns to this frame when the run suspends.
  const JsCallbackCollectorScope collector(this);
  {
  const CallScope call_scope(this);

  std::string reject_reason;
  bool threw = false;
  const std::optional<lua_core::LuaFunctionRef> func_ref =
    ResolveAsyncCallTarget(info[0], reject_reason, threw);
  if (threw) return val::undefined();
  if (!func_ref) return RejectedPromise(reject_reason);

  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  try {
    for (uint32_t i = 1; i < info.Length(); ++i) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[i])));
    }
  } catch (const std::exception& e) {
    return RejectedPromise(e.what());
  }

  std::variant<lua_core::LuaThreadRef, std::string> co = std::string();
  try {
    co = runtime_->CreateCoroutine(*func_ref);
  } catch (const std::exception& e) {
    return RejectedPromise(e.what());
  }
  if (std::holds_alternative<std::string>(co)) {
    return RejectedPromise(std::get<std::string>(co));
  }
  thread.emplace(std::move(std::get<lua_core::LuaThreadRef>(co)));
  }  // CallScope closes here — nothing below runs user JS before the drive

  // The commit-point check (see BeginAsyncRun). `thread` and the converted
  // arguments are dropped, and the collector sweeps the callbacks they minted.
  if (IsBusy()) return RejectedPromise(kAsyncBusyMessage);

  // Binding-owned, like execute_async.
  async_co_.emplace(std::move(*thread));
  // These are the caller's call arguments, not resume values (CR-23 F5).
  return BeginAsyncRun(Self(), args, "argument");
}

// Native: LuaContext::ActiveAsyncDeferred.
Deferred LuaContext::ActiveAsyncDeferred() const {
  assert(async_deferred_.has_value() && "no async run is in flight");
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access): precondition, see the native header.
  return *async_deferred_;
}

// Native: LuaContext::SettlePlainYield. A plain `coroutine.yield` reached the
// driver. The first of DriveAsync's three exits.
void LuaContext::SettlePlainYield(const lua_core::AsyncStepResult& step) {
  // Drop any promise a refused nested await (M1) left stashed: nothing is
  // going to consume it.
  async_pending_promise_.reset();

  // What a plain yield *means* depends on the door.
  if (async_coroutine_mode_) {
    // resume_async: an ordinary suspension. Settle with the yielded values and
    // detach, leaving the caller's thread suspended and resumable. Marshalling
    // runs user JS, so the supersede re-check is the one the Finished branch
    // makes (CR-16 F1).
    const uint64_t yield_gen = async_generation_;
    const Deferred yield_deferred = ActiveAsyncDeferred();
    val resolved = val::undefined();
    bool ok = true;
    std::string conv_err;
    try {
      // NOLINTNEXTLINE(bugprone-unchecked-optional-access): engaged for the whole of a resume_async run
      resolved = CoroutineResultToJs(*async_coro_obj_, lua_core::CoroutineStatus::Suspended,
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
      yield_deferred.Reject(js::NewErrorValue(
        std::string("failed to convert yielded values: ") + conv_err));
    }
    return;
  }
  // execute_async / call_async: nothing here can resume it.
  const Deferred deferred = ActiveAsyncDeferred();
  FinishAsync();
  deferred.Reject(js::NewErrorValue(
    "coroutine.yield is not supported at the top level of execute_async or "
    "call_async; only awaiting a host Promise suspends execution. Use "
    "resume_async() to drive a coroutine that yields"));
}

// Native: LuaContext::AttachToAwaitedPromise. The coroutine suspended for a
// host Promise: attach the continuation and return to the event loop. The
// second exit, and the only one that leaves the run in flight.
void LuaContext::AttachToAwaitedPromise() {
  // The whole attach runs guarded (CR-7 F2): `then` is user-influenced, so the
  // lookup or the call can throw, and unwinding out of DriveAsync mid-run
  // would leave the context wedged. On failure the run is settled instead.
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access): DriveAsync checked it
  const val promise = *async_pending_promise_;
  async_pending_promise_.reset();
  std::string attach_err;
  bool attached = false;
  // A hostile `then` can settle synchronously and THEN throw; the failure
  // branch below must not tear down a run that already ended.
  const uint64_t attach_gen = async_generation_;
  try {
    const val then_val = js::Get(promise, "then");
    if (!js::IsFunction(then_val)) {
      attach_err = "awaited Promise has no callable 'then'";
    } else {
      // The cookie outlives any duplicate or late settlement: the shell's
      // handle owns it and both continuations root that handle (L5). It
      // carries the liveness flag so a settlement arriving after the context
      // is destroyed is discarded without dereferencing it (CR-7 F1).
      auto cookie = std::make_unique<AwaitCookie>(
        AwaitCookie{this, async_generation_, false, alive_});
      const val callbacks = js::Host().call<val>(
        "awaitCallbacks", val(cookie.get(), emscripten::allow_raw_pointers()), shell_state_);
      // NOLINTNEXTLINE(bugprone-unused-return-value): the shell's handle owns it now
      (void)cookie.release();
      js::CallWithThis(then_val, promise, {callbacks[0], callbacks[1]});
      attached = true;
    }
  } catch (const std::exception& e) {
    attach_err = e.what();
  }
  if (!attached && !AsyncRunSuperseded(attach_gen)) {
    const Deferred deferred = ActiveAsyncDeferred();
    FinishAsync();
    deferred.Reject(js::NewErrorValue(
      "failed to attach to the awaited Promise: " + attach_err));
  }
}

// Native: LuaContext::SettleFinishedRun. The coroutine finished or raised. The
// third exit. Marshalling runs user JS between the copy of the deferred taken
// here and the settle, and `cancel()` is the one method that works while busy,
// so each branch re-checks before settling (CR-16 F1).
void LuaContext::SettleFinishedRun(const lua_core::AsyncStepResult& step) {
  const uint64_t settle_gen = async_generation_;
  const Deferred deferred = ActiveAsyncDeferred();

  // resume_async answers with the same `{ status, values, error? }` object
  // resume() does — including for a Lua error.
  if (async_coroutine_mode_) {
    val resolved = val::undefined();
    bool ok = true;
    std::string conv_err;
    const bool errored = step.state != lua_core::AsyncStepResult::State::Finished;
    try {
      resolved = CoroutineResultToJs(
        // NOLINTNEXTLINE(bugprone-unchecked-optional-access): engaged for the whole of a resume_async run
        *async_coro_obj_, lua_core::CoroutineStatus::Dead,
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
      deferred.Reject(js::NewErrorValue(
        std::string("failed to convert async result: ") + conv_err));
    }
    return;
  }

  if (step.state == lua_core::AsyncStepResult::State::Finished) {
    val resolved = val::undefined();
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
      deferred.Reject(js::NewErrorValue(
        std::string("failed to convert async result: ") + conv_err));
    }
  } else {
    // Reconstruct the original JS Error if this was a raised JS callback error.
    const val err_value = LuaErrorToJsValue(step.error);
    if (AsyncRunSuperseded(settle_gen)) return;
    FinishAsync();
    deferred.Reject(err_value);
  }
}

// Native: LuaContext::DriveAsync.
void LuaContext::DriveAsync(const std::vector<lua_core::LuaPtr>& args, const bool is_error,
                            const char* arg_role) {
  // Mark the resume window so a cancel() arriving re-entrantly from a host
  // callback defers its teardown until the coroutine leaves the C stack.
  lua_core::AsyncStepResult step;
  {
    const ScopedFlag resuming(async_resuming_);
    step = runtime_->ResumeAsyncStep(AsyncDrivenThread(), args, is_error, arg_role);
  }

  // Honor a cancel() that arrived during the resume.
  if (runtime_->IsCancelRequested()) {
    const Deferred deferred = ActiveAsyncDeferred();
    FinishAsync();
    deferred.Reject(js::NewErrorValue("execution cancelled"));
    return;
  }

  if (step.state != lua_core::AsyncStepResult::State::Awaiting) {
    SettleFinishedRun(step);
  } else if (!step.awaited || !async_pending_promise_) {
    SettlePlainYield(step);
  } else {
    AttachToAwaitedPromise();
  }
}

// Native: LuaContext::OnAwaitSettled.
val LuaContext::OnAwaitSettled(const val& value, const bool is_error, const uint64_t gen) {
  // Ignore a settlement from a run that has already ended or been superseded.
  if (AsyncRunSuperseded(gen)) {
    return val::undefined();
  }

  std::vector<lua_core::LuaPtr> args;
  // If the H2 re-check below drops this settlement, the callbacks minted while
  // converting it were never pushed and must be swept (N4).
  const JsCallbackCollectorScope collector(this);
  if (is_error) {
    // Every read below can run user JS and throw, and this callback cannot
    // tolerate a throw: fall back to a generic message and deliver the
    // rejection to Lua anyway (CR-8 F1).
    std::string msg;
    try {
      if (js::IsObject(value) && js::IsString(js::Get(value, "message"))) {
        msg = js::Utf8(js::Get(value, "message"));
      } else {
        msg = js::ToString(value);
      }
      // Stage a structured error for object rejections so the original JS
      // Error is reconstructed if the rejection surfaces uncaught.
      StageJsError(value, msg, nullptr);
    } catch (const std::exception&) {
      msg = "(rejection value could not be converted)";
      // Drop anything a partially-run StageJsError staged.
      if (runtime_->HasPendingErrorValue()) runtime_->TakePendingErrorValue();
    }
    if (runtime_->HasPendingErrorValue()) {
      args.push_back(runtime_->TakePendingErrorValue());
    } else {
      args.push_back(std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(msg)));
    }
  } else {
    // Converting the resolved value can throw; settle the deferred with the
    // error and tear down instead of leaving the run wedged.
    try {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value)));
    } catch (const std::exception& e) {
      const Deferred deferred = ActiveAsyncDeferred();
      FinishAsync();
      deferred.Reject(js::NewErrorValue(
        std::string("failed to convert awaited value: ") + e.what()));
      return val::undefined();
    }
  }
  // Marshalling above can run user JS that calls cancel() or even starts a new
  // run. Re-check before driving (H2).
  if (AsyncRunSuperseded(gen)) {
    return val::undefined();  // the collector's destructor sweeps the dropped args
  }
  DriveAsync(args, is_error);
  return val::undefined();
}

// Native: LuaContext::FinishAsync.
void LuaContext::FinishAsync() {
  runtime_->SetAwaitDriverMode(false);
  runtime_->SetAwaitDriverThread(nullptr);
  runtime_->ClearCancel();
  if (async_co_) {
    async_co_->release();  // binding-owned: this run created it
    async_co_.reset();
  }
  // A borrowed thread is never released here — the caller still holds the
  // coroutine object and may resume it again.
  async_borrowed_ = nullptr;
  async_coro_obj_.reset();
  async_coroutine_mode_ = false;
  async_deferred_.reset();
  async_pending_promise_.reset();
  async_self_ref_.reset();  // release the root taken in BeginAsyncRun
  shell_state_.set("run", val::undefined());
  js_error_registry_.clear();
  is_busy_ = false;
}

// Native: LuaContext::Cancel. Deliberately outside the occupancy guards — it
// has to work *while* a run is in flight.
val LuaContext::Cancel(const Args& /*info*/) {
  // A no-op rather than a throw on a closed context.
  if (closed_) return val::undefined();

  if (AsyncDriverEngaged()) {
    if (async_resuming_) {
      // Called re-entrantly from a host callback while the coroutine is still
      // executing on the C stack. Defer: DriveAsync observes the request once
      // the resume returns and finishes the run then.
      runtime_->RequestCancel();
      return val::undefined();
    }
    // Abandon the suspended coroutine and reject immediately. For a
    // resume_async run the thread is the caller's, so it is left suspended and
    // resumable; FinishAsync releases only a binding-owned thread.
    const Deferred deferred = ActiveAsyncDeferred();
    FinishAsync();
    deferred.Reject(js::NewErrorValue("execution cancelled"));
  } else if (is_busy_) {
    // A deferred run (execute_script_async / execute_file_async) has been
    // accepted. Natively it is running on a worker and this interrupts it at
    // the next instruction-count check, when one is installed. Here the run
    // either has not started or is suspended in that same check, and sees the
    // request when it goes on.
    runtime_->RequestCancel();
  }
  return val::undefined();
}

// --- coroutines -------------------------------------------------------------

// Native: LuaContext::CreateCoroutineObject. The shell builds the object — the
// marker, `status`, and the two iterator factories, each rooting its own
// binding — around the three structs made here.
val LuaContext::CreateCoroutineObject(std::unique_ptr<LuaThreadData> data,
                                      const std::string& status) {
  auto binding = std::make_unique<LuaContextBinding>(LuaContextBinding{this, Liveness()});
  // A second binding rather than a shared one, as natively: each is owned by
  // its own handle.
  auto async_binding = std::make_unique<LuaContextBinding>(LuaContextBinding{this, Liveness()});
  val coro = js::Host().call<val>(
    "coroutineObject", val(data.get(), emscripten::allow_raw_pointers()),
    val(binding.get(), emscripten::allow_raw_pointers()),
    val(async_binding.get(), emscripten::allow_raw_pointers()), js::String(status),
    shell_state_);
  // NOLINTBEGIN(bugprone-unused-return-value): the shell's handles own them now
  (void)data.release();
  (void)binding.release();
  (void)async_binding.release();
  // NOLINTEND(bugprone-unused-return-value)
  return coro;
}

// Native: LuaContext::CreateCoroutine. Takes a script string that *returns* a
// function, or a Lua function already held on the JS side (A4).
val LuaContext::CreateCoroutine(const Args& info) {
  if (RejectIfBusy()) return val::undefined();

  std::optional<lua_core::LuaFunctionRef> func_ref;

  if (info.Length() >= 1 && js::IsFunction(info[0])) {
    const auto* fn_data = LuaFunctionDataFrom(info[0]);
    if (!fn_data) {
      js::ThrowTypeError(
        "create_coroutine() accepts a script string or a Lua function; a plain "
        "JavaScript function cannot be a coroutine body");
      return val::undefined();
    }
    // Same identity checks resume() applies (M1).
    if (fn_data->runtime.get() != runtime_.get()) {
      js::ThrowError("Lua function belongs to a different Lua context");
      return val::undefined();
    }
    if (fn_data->func_ref.ref == LUA_NOREF) {
      js::ThrowError("Lua function has been released");
      return val::undefined();
    }
    // Copying shares the registry slot's ownership, so the coroutine body
    // outlives the JS wrapper.
    func_ref = fn_data->func_ref;
  } else {
    if (info.Length() < 1 || !js::IsString(info[0])) {
      js::ThrowTypeError("Expected a script string that returns a function, or a Lua function");
      return val::undefined();
    }

    const std::string script = js::Utf8(info[0]);
    const CallScope call_scope(this);
    std::string chunk_name;
    if (!ParseChunkName(info, 1, "create_coroutine()", chunk_name)) return val::undefined();

    const auto res = runtime_->ExecuteScript(script, chunk_name);
    if (std::holds_alternative<std::string>(res)) {
      ThrowLuaError(std::get<std::string>(res));
      return val::undefined();
    }

    const auto& values = std::get<std::vector<lua_core::LuaPtr>>(res);
    if (values.empty() || !std::holds_alternative<lua_core::LuaFunctionRef>(values[0]->value)) {
      js::ThrowTypeError("Script must return a function");
      return val::undefined();
    }
    func_ref = std::get<lua_core::LuaFunctionRef>(values[0]->value);
  }

  auto result = runtime_->CreateCoroutine(*func_ref);
  if (std::holds_alternative<std::string>(result)) {
    js::ThrowError(std::get<std::string>(result));
    return val::undefined();
  }

  const auto& thread_ref = std::get<lua_core::LuaThreadRef>(result);
  return CreateCoroutineObject(
    std::make_unique<LuaThreadData>(runtime_, thread_ref), "suspended");
}

// Native: LuaContext::ResumeCoroutine.
val LuaContext::ResumeCoroutine(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // Clears the JS-error registry at the outermost entry (L7).
  const CallScope scope(this);
  if (info.Length() < 1 || !js::IsObject(info[0])) {
    js::ThrowTypeError("Expected a coroutine object as first argument");
    return val::undefined();
  }

  std::vector<val> args;
  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  for (uint32_t i = 1; i < info.Length(); ++i) args.push_back(info[i]);
  return ResumeCoroutineObject(info[0], args);
}

// Native: LuaContext::CloseCoroutine. close(coro) — P3. Runs a suspended
// coroutine's pending to-be-closed variables and marks the thread dead.
val LuaContext::CloseCoroutine(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // A __close handler runs Lua, which can reach a host callback (CR-9 F1).
  const CallScope scope(this);
  if (info.Length() < 1 || !js::IsObject(info[0])) {
    js::ThrowTypeError("close(coroutine) requires a coroutine object");
    return val::undefined();
  }
  const val coro_obj = info[0];

  // Single branded read, and the same identity checks resume applies.
  const auto* thread_data = TaggedThreadData(js::Get(coro_obj, "_coroutine"));
  if (!thread_data || !thread_data->runtime) {
    js::ThrowTypeError("Invalid coroutine object");
    return val::undefined();
  }
  if (thread_data->runtime.get() != runtime_.get()) {
    js::ThrowError("coroutine belongs to a different Lua context");
    return val::undefined();
  }
  // Released, so there is no thread to close. Not an error.
  if (thread_data->thread_ref.ref == LUA_NOREF) return val::undefined();

  std::optional<std::string> err;
  try {
    err = runtime_->CloseCoroutine(thread_data->thread_ref);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  // The thread is dead either way, so the status is updated before the error
  // is raised.
  js::Set(coro_obj, "status", js::String("dead"));
  if (err) {
    ThrowLuaError(*err);
    return val::undefined();
  }
  return val::undefined();
}

// Native: LuaContext::ResumeAsync. resume_async(coro, ...args) — P1b.
val LuaContext::ResumeAsync(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsObject(info[0])) {
    js::ThrowTypeError("resume_async(coroutine, ...args) requires a coroutine object");
    return val::undefined();
  }
  std::vector<val> args;
  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  for (uint32_t i = 1; i < info.Length(); ++i) args.push_back(info[i]);
  return ResumeCoroutineObjectAsync(info[0], args, Self());
}

// Native: LuaContext::ResumeCoroutineObjectAsync.
val LuaContext::ResumeCoroutineObjectAsync(const val& coro_obj, const std::vector<val>& args_js,
                                           const val& self) {
  // The entry check, here rather than in the callers so neither can skip it.
  // resume_async never reaches it busy — its RejectIfBusy throws first. The
  // async cursor's `next` has no check of its own and relies on this one; it
  // gets a rejection because it settles a promise for everything, and it is
  // not marked done, so the cursor works again once the context is free.
  // Before anything else, and not only at the commit point below: a deferred
  // run may be what holds the context.
  if (IsBusy()) return RejectedPromise(kAsyncBusyMessage);

  // Scoped like CallAsync's, and for the same two reasons (CR-13 F1, CR-10 F1).
  const LuaThreadData* thread_data = nullptr;
  std::vector<lua_core::LuaPtr> args;
  // One collector spans every argument (CR-8 F1), and stays open across the
  // drive that pushes them — see CallAsync, which had the same early close.
  const JsCallbackCollectorScope collector(this);
  {
  const CallScope call_scope(this);

  // Identical validation to ResumeCoroutineObject; reported as rejections
  // rather than throws past the argument check.
  thread_data = TaggedThreadData(js::Get(coro_obj, "_coroutine"));
  if (!thread_data || !thread_data->runtime) {
    js::ThrowTypeError("Invalid coroutine object");
    return val::undefined();
  }
  if (thread_data->runtime.get() != runtime_.get()) {
    return RejectedPromise("coroutine belongs to a different Lua context");
  }
  if (thread_data->thread_ref.ref == LUA_NOREF) {
    return RejectedPromise("coroutine has been released");
  }

  args.reserve(args_js.size());
  try {
    for (const auto& arg : args_js) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arg)));
    }
  } catch (const std::exception& e) {
    return RejectedPromise(e.what());
  }
  }  // CallScope closes here — nothing below runs user JS before the drive

  // The commit-point check (see BeginAsyncRun): the marker read and the
  // conversion above ran user JS, which may have started a run of its own.
  if (IsBusy()) return RejectedPromise(kAsyncBusyMessage);

  // Borrowed, not owned: async_co_ stays disengaged so FinishAsync releases
  // nothing, and the coroutine object is rooted for the run because
  // async_borrowed_ points into data that object's handle owns.
  async_borrowed_ = thread_data;
  async_coro_obj_ = coro_obj;
  async_coroutine_mode_ = true;
  return BeginAsyncRun(self, args);
}

// Native: LuaContext::ResumeCoroutineObject.
val LuaContext::ResumeCoroutineObject(const val& coro_obj, const std::vector<val>& args_js) {
  // Single branded read (CR-15 F6).
  const auto* thread_data = TaggedThreadData(js::Get(coro_obj, "_coroutine"));
  if (!thread_data) {
    js::ThrowTypeError("Invalid coroutine object");
    return val::undefined();
  }
  if (!thread_data->runtime) {
    js::ThrowError("Invalid coroutine reference");
    return val::undefined();
  }
  // Resuming a coroutine created by another context would drive that
  // context's thread with this context's main state (M1).
  if (thread_data->runtime.get() != runtime_.get()) {
    js::ThrowError("coroutine belongs to a different Lua context");
    return val::undefined();
  }

  // A released ref carries LUA_NOREF and a null thread pointer.
  if (thread_data->thread_ref.ref == LUA_NOREF) {
    js::ThrowError("coroutine has been released");
    return val::undefined();
  }

  // One collector spans every argument (CR-8 F1).
  const JsCallbackCollectorScope collector(this);
  std::vector<lua_core::LuaPtr> args;
  args.reserve(args_js.size());
  try {
    for (const auto& arg : args_js) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arg)));
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  auto [status, values, error] = runtime_->ResumeCoroutine(thread_data->thread_ref, args);
  return CoroutineResultToJs(coro_obj, status, values, error);
}

// Native: LuaContext::CoroutineResultToJs. One coroutine step as the
// `{ status, values, error? }` object both resume() and resume_async() answer
// with; also updates the coroutine object's own `status`.
val LuaContext::CoroutineResultToJs(const val& coro_obj, const lua_core::CoroutineStatus status,
                                    const std::vector<lua_core::LuaPtr>& values,
                                    const std::optional<std::string>& error) {
  val result_obj = val::object();

  const std::string status_str = CoroutineStatusName(status);
  js::Set(result_obj, "status", js::String(status_str));

  // Update the coroutine object's status too
  js::Set(coro_obj, "status", js::String(status_str));

  val values_arr = val::array();
  for (size_t i = 0; i < values.size(); ++i) {
    js::Set(values_arr, std::to_string(i), CoreToNapi(*values[i]));
  }
  js::Set(result_obj, "values", values_arr);

  if (error.has_value()) {
    // Consume any staged fidelity state so it does not linger after this
    // resume (L7). The coroutine API surfaces the error as a string, so the
    // reconstructed Error object is intentionally discarded.
    (void)LuaErrorToJsValue(error.value());
    js::Set(result_obj, "error", js::String(error.value()));
  }

  return result_obj;
}

// --- modules ----------------------------------------------------------------

// Native: LuaContext::AddSearchPath.
val LuaContext::AddSearchPath(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string argument");
    return val::undefined();
  }

  const std::string path = js::Utf8(info[0]);

  if (path.find('?') == std::string::npos) {
    js::ThrowError("Search path must contain a '?' placeholder (e.g., './modules/?.lua')");
    return val::undefined();
  }

  try {
    // Reads and writes package.path, so a metatabled package runs its
    // __index/__newindex here (CR-9 F1).
    const CallScope call_scope(this);
    runtime_->AddSearchPath(path);
  } catch (const std::runtime_error& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
  // Recorded only after the core call succeeds, so a rejected path is never
  // replayed by reset().
  search_paths_.push_back(path);

  return val::undefined();
}

// Native: LuaContext::RegisterModule.
val LuaContext::RegisterModule(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // At entry, above the reads of the module object below (CR-13 F1).
  const CallScope call_scope(this);
  if (info.Length() < 2 || !js::IsString(info[0]) || !js::IsObject(info[1])) {
    js::ThrowTypeError("Expected (string, object)");
    return val::undefined();
  }

  const std::string name = js::Utf8(info[0]);
  const val module_obj = info[1];
  const val keys = js::Keys(module_obj);
  const uint32_t count = js::Length(keys);

  const uint64_t mod_id = next_module_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  // See SetMetatable: one collector spans the entry build and the core call (F1).
  const JsCallbackCollectorScope collector(this);

  // See SetMetatable: function entries are registered only after the core call
  // succeeds — RegisterModuleTable throws when the 'package' library isn't
  // loaded (CR-8 F3).
  FunctionList deferred_fns;

  for (uint32_t i = 0; i < count; i++) {
    const std::string key = js::Utf8(keys[i]);
    const val value = js::Get(module_obj, key);

    lua_core::MetatableEntry entry;
    entry.key = key;

    if (js::IsFunction(value)) {
      const std::string func_name = "__module_" + std::to_string(mod_id) + "_" + key;
      deferred_fns.emplace_back(func_name, value);
      entry.is_function = true;
      entry.func_name = func_name;
    } else {
      entry.is_function = false;
      try {
        entry.value = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value));
      } catch (const std::exception& e) {
        js::ThrowError(e.what());
        return val::undefined();
      }
    }

    entries.push_back(std::move(entry));
  }

  // See SetMetatable: reserved before the core call so re-registering the same
  // module name releases the previous generation's callbacks (CR-11 F4).
  ReserveDeferredCallbacks(deferred_fns);

  try {
    runtime_->RegisterModuleTable(name, entries);
  } catch (const std::runtime_error& e) {
    js::ThrowError(e.what());
    return val::undefined();  // nothing registered, nothing stranded (CR-8 F3)
  }

  for (const auto& [func_name, fn] : deferred_fns) {
    js_callbacks_.insert_or_assign(func_name, fn);
    runtime_->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }

  return val::undefined();
}

// Native: LuaContext::AddSearcher.
val LuaContext::AddSearcher(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsFunction(info[0])) {
    js::ThrowTypeError("add_searcher(fn) requires a function");
    return val::undefined();
  }
  const std::string name = "__searcher_" + std::to_string(next_searcher_id_++);
  // Core call first: if it throws (the 'package' library isn't loaded), no
  // js_callbacks_/host_functions_ entry is left behind (N5, CR-7 F4).
  try {
    // Reads package.searchers and appends to it (CR-9 F1).
    const CallScope call_scope(this);
    runtime_->AddJsSearcher(name);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
  js_callbacks_.insert_or_assign(name, info[0]);
  runtime_->StoreHostFunction(name, CreateJsCallbackWrapper(name));
  // Recorded only after the core call succeeds, so a rejected registration is
  // never replayed by reset() (CR-9 F3). A second reference to the same
  // function with a different lifetime, not a leak: see the native comment.
  searchers_.push_back(info[0]);
  return val::undefined();
}

// --- bytecode ---------------------------------------------------------------

// Native: LuaContext::Compile. Answers with a plain Uint8Array where the native
// binding answers with a Node Buffer (plan, D4).
val LuaContext::Compile(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string argument");
    return val::undefined();
  }

  const std::string script = js::Utf8(info[0]);

  // Above the options reads below, which can be accessors (CR-13 F1), as well
  // as the parse further down.
  const CallScope call_scope(this);

  bool strip_debug = false;
  std::string chunk_name;
  if (!ParseChunkName(info, 1, "compile()", chunk_name)) return val::undefined();
  if (info.Length() >= 2 && js::IsObject(info[1])) {
    const val options = info[1];
    if (js::Has(options, "stripDebug") && js::IsBoolean(js::Get(options, "stripDebug"))) {
      strip_debug = js::Get(options, "stripDebug").as<bool>();
    }
  }

  // Compiling parses, parsing allocates, and an allocation can drive a GC step
  // whose __gc finalizers re-enter JS (CR-10 F1).
  const auto result = runtime_->CompileScript(script, strip_debug, chunk_name);

  if (std::holds_alternative<std::string>(result)) {
    js::ThrowError(std::get<std::string>(result));
    return val::undefined();
  }

  const auto& bytecode = std::get<std::vector<uint8_t>>(result);
  return js::Uint8Array(std::string(bytecode.begin(), bytecode.end()));
}

// Native: LuaContext::CompileFile.
val LuaContext::CompileFile(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("Expected string argument");
    return val::undefined();
  }

  const std::string filepath = js::Utf8(info[0]);

  // See Compile: above the options reads, which can be accessors (CR-13 F1).
  const CallScope call_scope(this);

  bool strip_debug = false;
  if (info.Length() >= 2 && js::IsObject(info[1])) {
    const val options = info[1];
    if (js::Has(options, "stripDebug") && js::IsBoolean(js::Get(options, "stripDebug"))) {
      strip_debug = js::Get(options, "stripDebug").as<bool>();
    }
  }

  const auto result = runtime_->CompileFile(filepath, strip_debug);

  if (std::holds_alternative<std::string>(result)) {
    js::ThrowError(std::get<std::string>(result));
    return val::undefined();
  }

  const auto& bytecode = std::get<std::vector<uint8_t>>(result);
  return js::Uint8Array(std::string(bytecode.begin(), bytecode.end()));
}

// Native: LuaContext::LoadBytecode. The refusal keeps the native wording, as
// every refusal does (plan, D2); what is accepted is what `napi_is_buffer`
// accepts — any ArrayBuffer view, which a Uint8Array is.
val LuaContext::LoadBytecode(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsBufferView(info[0])) {
    js::ThrowTypeError("Expected Buffer argument");
    return val::undefined();
  }

  const std::string bytes = js::Bytes(info[0]);
  const std::vector<uint8_t> bytecode(bytes.begin(), bytes.end());

  std::string chunk_name = "bytecode";
  if (info.Length() >= 2 && js::IsString(info[1])) {
    chunk_name = js::Utf8(info[1]);
  }

  const CallScope call_scope(this);
  const auto res = runtime_->LoadBytecode(bytecode, chunk_name);

  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return val::undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

// --- the debug hook, the stack and locals -----------------------------------

// Native: LuaContext::InstallDebugHook. Shared by set_hook and reset().
void LuaContext::InstallDebugHook(const val& fn, const int mask, const int count) {
  runtime_->SetDebugHook(
    [this](const std::string& event, int line, const std::string& name) {
      if (!debug_hook_) return;
      // This runs inside Lua's execution, between VM instructions, so nothing
      // may unwind out of it. A throwing hook is swallowed; see
      // InstallPrintHandler for why this catches everything (CR-18 F3).
      try {
        const val hook = *debug_hook_;
        js::Call(hook, {js::String(event), val(line), js::String(name)});
      } catch (...) {
        // Deliberately swallowed; see above.
      }
    }, mask, count);

  debug_hook_ = fn;
  debug_hook_mask_ = mask;
  debug_hook_count_ = count;
}

// Native: LuaContext::SetHook. set_hook(callback, options) — trace Lua
// execution via lua_sethook.
val LuaContext::SetHook(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // At entry, above the options-object reads below (CR-13 F1).
  const CallScope call_scope(this);

  if (info.Length() < 1 || !js::IsFunction(info[0])) {
    js::ThrowTypeError("set_hook(callback, options) requires a function");
    return val::undefined();
  }
  if (info.Length() < 2 || js::KindOf(info[1]) != js::Kind::Object || js::IsArray(info[1])) {
    js::ThrowTypeError(
      "set_hook(callback, options) requires an options object "
      "({ call?, return?, line?, count? })");
    return val::undefined();
  }

  const val options = info[1];
  const auto flag = [&options](const char* key) {
    if (!js::Has(options, key)) return false;
    const val v = js::Get(options, key);
    return !js::IsNullish(v) && v.as<bool>();
  };

  int mask = 0;
  if (flag("call")) mask |= LUA_MASKCALL;
  if (flag("return")) mask |= LUA_MASKRET;
  if (flag("line")) mask |= LUA_MASKLINE;

  int count = 0;
  if (js::Has(options, "count")) {
    const val count_val = js::Get(options, "count");
    if (!js::IsNullish(count_val)) {
      if (!js::IsNumber(count_val)) {
        js::ThrowTypeError("set_hook(): count must be a number");
        return val::undefined();
      }
      const auto raw = count_val.as<double>();
      if (!(raw >= 1) || raw != std::trunc(raw) ||
          raw > static_cast<double>(std::numeric_limits<int>::max())) {
        js::ThrowRangeError("set_hook(): count must be a positive integer");
        return val::undefined();
      }
      count = static_cast<int>(raw);
      mask |= LUA_MASKCOUNT;
    }
  }

  if (mask == 0) {
    js::ThrowTypeError(
      "set_hook(): at least one of call, return, line, or count must be requested");
    return val::undefined();
  }

  // SetDebugHook allocates the shared callback owner, so it can throw (CR-9 F4).
  try {
    InstallDebugHook(info[0], mask, count);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
  }
  return val::undefined();
}

// Native: LuaContext::RemoveHook. A no-op when no hook is set.
val LuaContext::RemoveHook(const Args& /*info*/) {
  if (RejectIfBusy()) return val::undefined();

  runtime_->RemoveDebugHook();
  debug_hook_.reset();
  debug_hook_mask_ = 0;
  debug_hook_count_ = 0;
  return val::undefined();
}

// Native: LuaContext::GetStack. R1: read-only debug introspection, callable
// from inside a set_hook callback.
val LuaContext::GetStack(const Args& info) {
  if (RejectIfBusy()) return val::undefined();

  // Scoped for the options read alone: it can be an accessor (CR-13 F1).
  int max_levels = 200;
  {
    const CallScope call_scope(this);
    if (info.Length() > 0 && js::IsObject(info[0])) {
      const val lv = js::Get(info[0], "maxLevels");
      if (js::IsNumber(lv)) {
        const int want = js::Int32(lv);
        if (want < 0) {
          js::ThrowRangeError("maxLevels must be a non-negative integer");
          return val::undefined();
        }
        max_levels = want;
      }
    }
  }

  std::vector<lua_core::LuaRuntime::StackFrame> frames;
  try {
    frames = runtime_->GetStack(max_levels);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }

  val out = val::array();
  for (size_t i = 0; i < frames.size(); ++i) {
    const auto& f = frames[i];
    val o = val::object();
    js::Set(o, "level", val(f.level));
    js::Set(o, "source", js::String(f.source));
    js::Set(o, "shortSource", js::String(f.short_src));
    js::Set(o, "currentLine", val(f.current_line));
    js::Set(o, "lineDefined", val(f.line_defined));
    js::Set(o, "name", js::String(f.name));
    js::Set(o, "nameWhat", js::String(f.name_what));
    js::Set(o, "what", js::String(f.what));
    js::Set(out, std::to_string(i), o);
  }
  return out;
}

// Native: LuaContext::GetLocals.
val LuaContext::GetLocals(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1 || !js::IsNumber(info[0])) {
    js::ThrowTypeError("get_locals(level) requires a stack level");
    return val::undefined();
  }
  const int level = js::Int32(info[0]);
  if (level < 0) {
    js::ThrowRangeError("level must be a non-negative integer");
    return val::undefined();
  }

  // The conversion below runs registered from-Lua converters, i.e. user JS, so
  // the scope is not optional (CR-9 F1 / CR-13 F1).
  const CallScope call_scope(this);
  std::optional<std::vector<std::pair<std::string, lua_core::LuaPtr>>> locals;
  try {
    locals = runtime_->GetLocals(level);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
  if (!locals) {
    // A refusal rather than an empty array: "no such frame" and "a frame with
    // no named locals" are different answers.
    js::ThrowRangeError("no stack frame at level " + std::to_string(level)
      + "; call get_stack() to see which levels exist");
    return val::undefined();
  }

  val out = val::array();
  for (size_t i = 0; i < locals->size(); ++i) {
    val o = val::object();
    js::Set(o, "name", js::String((*locals)[i].first));
    js::Set(o, "value", CoreToNapi(*(*locals)[i].second));
    js::Set(out, std::to_string(i), o);
  }
  return out;
}

// --- the print, read and file handlers --------------------------------------

// Native: LuaContext::SetPrintHandler.
val LuaContext::SetPrintHandler(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  // The print/io.write overrides are protected _G writes, which throw on a
  // raising __newindex on a _G metatable or on OOM (CR-6 F1).
  try {
    const CallScope call_scope(this);
    if (info.Length() >= 1 && js::IsFunction(info[0])) {
      InstallPrintHandler(info[0]);
    } else {
      // null/undefined clears redirection (print/io.write go to stdout).
      print_handler_.reset();
      runtime_->SetOutputHandler(nullptr);
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
  return val::undefined();
}

// Native: LuaContext::InstallReadHandler. Same ordering as InstallPrintHandler
// (CR-8 F7): the runtime install can throw, and read_handler_ must not be left
// pointing at a handler io.read was never rewired to reach.
bool LuaContext::InstallReadHandler(const val& fn) {
  const bool wired = runtime_->SetInputHandler(
    [this](const lua_core::LuaPtr& format) -> std::optional<std::string> {
      if (!read_handler_) return std::nullopt;
      // The format token is protocol metadata this binding mints — "l", "n",
      // "a", or a byte count — not a value coming out of the script, so it is
      // built directly instead of being run through the value converter
      // (CR-23 F2).
      val format_js = val::undefined();
      if (format) {
        if (const auto* spec = std::get_if<std::string>(&format->value)) {
          format_js = js::String(*spec);
        } else if (const auto* count = std::get_if<double>(&format->value)) {
          format_js = val(*count);
        } else if (const auto* n = std::get_if<int64_t>(&format->value)) {
          format_js = val(static_cast<double>(*n));
        }
      }
      val result = val::undefined();
      try {
        const val handler = *read_handler_;
        result = js::Call(handler, {format_js});
      } catch (const js::JsError& e) {
        // Re-thrown with the message extracted here, so a non-Error throw
        // keeps its text (CR-18 F2).
        throw js::MakeError(js::ThrowMessage(e));
      }
      // null / undefined / any boolean mean end-of-input, which reaches Lua as
      // nil. Deliberately not "empty string means EOF".
      if (js::IsNullish(result) || js::IsBoolean(result)) {
        return std::nullopt;
      }
      // Bytes are taken as bytes (CR-23 F2).
      if (js::KindOf(result) == js::Kind::Object &&
          js::ObjectKindOf(result) == js::ObjectKind::Binary) {
        return js::Bytes(result);
      }
      return js::ToString(result);
    });
  // Not committed when the core refused to wire io.read, and any previous
  // handler goes too: see the native comment.
  if (!wired) {
    read_handler_.reset();
    return false;
  }
  read_handler_ = fn;
  return true;
}

// Native: LuaContext::SetReadHandler. set_read_handler(handler | null) — P4a.
// Returns whether io.read is now wired.
val LuaContext::SetReadHandler(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  bool wired = true;
  try {
    // The io.read override is a protected write through a table a metatabled
    // `io` could trap, and it allocates a closure (CR-9 F1, M3).
    const CallScope call_scope(this);
    if (info.Length() >= 1 && js::IsFunction(info[0])) {
      wired = InstallReadHandler(info[0]);
    } else {
      // The core removal runs first and can throw; read_handler_ must not be
      // cleared for a removal that did not happen.
      runtime_->SetInputHandler(nullptr);
      read_handler_.reset();
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
  return val(wired);
}

// Native: LuaContext::InstallFileReader.
void LuaContext::InstallFileReader(const val& fn) {
  runtime_->SetFileReader(
    [this](const std::string& path) -> std::optional<std::string> {
      if (!file_reader_) return std::nullopt;
      val result = val::undefined();
      try {
        const val reader = *file_reader_;
        result = js::Call(reader, {js::String(path)});
      } catch (const js::JsError& e) {
        throw js::MakeError(js::ThrowMessage(e));  // see the read handler (CR-18 F2)
      }
      // null / undefined / any boolean mean "no such file". An empty string is
      // a valid empty module, so it is not folded into the same answer.
      if (js::IsNullish(result) || js::IsBoolean(result)) {
        return std::nullopt;
      }
      return js::ToString(result);
    });
  file_reader_ = fn;
}

// Native: LuaContext::SetFileReader. set_file_reader(reader | null) — P4b.
val LuaContext::SetFileReader(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  try {
    // Installing reassigns the dofile/loadfile globals, so a metatabled _G runs
    // its __newindex here (CR-9 F1).
    const CallScope call_scope(this);
    if (info.Length() >= 1 && js::IsFunction(info[0])) {
      InstallFileReader(info[0]);
    } else {
      file_reader_.reset();
      runtime_->SetFileReader(nullptr);
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
  return val::undefined();
}

// --- introspection ----------------------------------------------------------

// Native: LuaContext::GetMemoryUsage.
// NOLINTNEXTLINE(readability-make-member-function-const)
val LuaContext::GetMemoryUsage(const Args& /*info*/) {
  if (RejectIfBusy()) return val::undefined();
  return val(static_cast<double>(runtime_->GetMemoryUsage()));
}

// Native: LuaContext::Info. A diagnostics snapshot: which Lua this is, how much
// memory it holds, and the limits and libraries it was configured with.
// `memoryKB` is `memoryBytes / 1024` rather than a second reading, so the two
// can never disagree.
val LuaContext::Info(const Args& /*info*/) {
  if (RejectIfBusy()) return val::undefined();

  const auto memory_bytes = static_cast<double>(runtime_->GetMemoryUsage());

  val result = val::object();
  js::Set(result, "version", js::String(lua_core::LuaRuntime::GetVersion()));
  js::Set(result, "release", js::String(lua_core::LuaRuntime::GetRelease()));
  js::Set(result, "versionNumber", val(lua_core::LuaRuntime::GetVersionNumber()));
  js::Set(result, "memoryBytes", val(memory_bytes));
  js::Set(result, "memoryKB", val(memory_bytes / 1024.0));
  js::Set(result, "memoryLimit", val(static_cast<double>(runtime_->GetMemoryLimit())));
  js::Set(result, "maxInstructions",
          val(static_cast<double>(runtime_->GetMaxInstructions())));
  js::Set(result, "timeout", val(static_cast<double>(runtime_->GetTimeout())));

  // The libraries this state was opened with, verbatim from the config the
  // runtime kept.
  const auto& libraries = runtime_->GetConfig().libraries;
  val libs = val::array();
  for (size_t i = 0; i < libraries.size(); ++i) {
    js::Set(libs, std::to_string(i), js::String(libraries[i]));
  }
  js::Set(result, "libraries", libs);

  js::Set(result, "bindingRefs", BindingRefCounts());

  return result;
}

// Native: LuaContext::BindingRefCounts. How many JS values this context's own
// bookkeeping is holding alive, by container — the same thirteen names, over
// this binding's own containers, so `binding-balance` measures this binding
// and not a stub (plan, Phase 2). Each field counts *entries*.
val LuaContext::BindingRefCounts() {
  size_t accessor_props = 0;
  for (const auto& [class_name, table] : class_accessors_) {
    accessor_props += table.props.size();
  }

  // The four redirection handlers share one counter: identical lifetimes.
  const size_t handlers =
    static_cast<size_t>(print_handler_.has_value()) +
    static_cast<size_t>(read_handler_.has_value()) +
    static_cast<size_t>(file_reader_.has_value()) +
    static_cast<size_t>(debug_hook_.has_value());

  // The async trio is transient by construction, which makes it the one group
  // where a non-zero reading at rest is itself the finding.
  const size_t async_refs =
    static_cast<size_t>(async_coro_obj_.has_value()) +
    static_cast<size_t>(async_pending_promise_.has_value()) +
    static_cast<size_t>(async_self_ref_.has_value());

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
    static_cast<size_t>(callbacks_ref_.has_value()),
  };
  static constexpr std::array kNames = {
    "callbacks", "userdata", "userdataMethods", "errorRegistry", "classes",
    "classAccessors", "typeConverters", "fromLuaConverters", "searchers",
    "sharedTables", "handlers", "asyncRefs", "callbacksObject",
  };
  static_assert(counts.size() == kNames.size(),
                "every bindingRefs count needs a name");

  val refs = val::object();
  size_t total = 0;
  for (size_t i = 0; i < counts.size(); ++i) {
    js::Set(refs, kNames[i], val(static_cast<double>(counts[i])));
    total += counts[i];
  }
  js::Set(refs, "total", val(static_cast<double>(total)));
  return refs;
}

// --- the collector ----------------------------------------------------------

namespace {

// Native: ReadGCParamValue. gc('param', name, value?): the optional third
// argument. Returns false with a JS exception pending.
bool ReadGCParamValue(const Args& info, int& value) {
  if (info.Length() <= 2 || js::IsNullish(info[2])) return true;
  if (!js::IsNumber(info[2])) {
    js::ThrowTypeError("gc('param', name, value): value must be a number");
    return false;
  }
  const auto raw = info[2].as<double>();
  if (raw < 0 || raw > lua_core::LuaRuntime::kMaxGCParam) {
    js::ThrowRangeError(
      "gc('param', name, value): value must be between 0 and " +
      std::to_string(lua_core::LuaRuntime::kMaxGCParam));
    return false;
  }
  value = static_cast<int>(raw);
  return true;
}

// Native: ReadGCStepSize. gc('step', stepSize?): the optional second argument.
bool ReadGCStepSize(const Args& info, size_t& step_size) {
  if (info.Length() <= 1 || js::IsNullish(info[1])) return true;
  if (!js::IsNumber(info[1])) {
    js::ThrowTypeError("gc('step', stepSize): stepSize must be a number");
    return false;
  }
  const auto step = SizeLimitFromNumber(info[1].as<double>());
  if (!step) {
    js::ThrowRangeError("gc('step', stepSize): stepSize must be non-negative");
    return false;
  }
  step_size = *step;
  return true;
}

}  // namespace

// Native: LuaContext::GC. A thin pass-through to lua_gc, using Lua's own
// `collectgarbage` command vocabulary.
val LuaContext::GC(const Args& info) {
  if (RejectIfBusy()) return val::undefined();

  if (info.Length() < 1 || !js::IsString(info[0])) {
    js::ThrowTypeError("gc(command) requires a command string (e.g. 'collect', 'count')");
    return val::undefined();
  }
  const std::string command = js::Utf8(info[0]);

  // 'collect' and 'step' run __gc finalizers, which are Lua and can re-enter a
  // host callback (CR-9 F1); this scope also clears the JS-error registry at
  // the outermost entry.
  const CallScope call_scope(this);

  try {
    if (command == "param") {
      if (info.Length() < 2 || !js::IsString(info[1])) {
        js::ThrowTypeError("gc('param', name, value?) requires a parameter name string");
        return val::undefined();
      }
      const std::string param = js::Utf8(info[1]);
      // Omitting the value reads the current setting without changing it,
      // which Lua spells as a negative value.
      int value = -1;
      if (!ReadGCParamValue(info, value)) return val::undefined();
      return val(runtime_->GarbageCollectParam(param, value));
    }

    size_t step_size = 0;
    if (command == "step" && !ReadGCStepSize(info, step_size)) {
      return val::undefined();
    }

    const auto result = runtime_->GarbageCollect(command, step_size);
    return std::visit([](const auto& v) -> val {
      using T = std::decay_t<decltype(v)>;
      if constexpr (std::is_same_v<T, double> || std::is_same_v<T, bool>) {
        return val(v);
      } else if constexpr (std::is_same_v<T, std::string>) {
        return js::String(v);
      } else {
        return val::undefined();
      }
    }, result);
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return val::undefined();
  }
}

// --- release, dispose, reset ------------------------------------------------

// Native: LuaContext::ReleaseObjectHandle. A coroutine or a table reference:
// true if `obj` carried either marker (with a JS exception pending if it was
// another context's), false if it carries neither. Each marker is read once
// and checked for kind.
// NOLINTNEXTLINE(readability-make-member-function-const)
bool LuaContext::ReleaseObjectHandle(const val& obj) {
  if (auto* data = TaggedThreadData(js::Get(obj, "_coroutine"))) {
    if (data->runtime.get() != runtime_.get()) {
      js::ThrowError("value belongs to a different Lua context");
      return true;
    }
    if (data->thread_ref.ref != LUA_NOREF) data->thread_ref.release();
    return true;
  }

  if (auto* data = TaggedTableData(js::Get(obj, "_tableRef"))) {
    if (data->runtime.get() != runtime_.get()) {
      js::ThrowError("value belongs to a different Lua context");
      return true;
    }
    if (data->table_ref.ref != LUA_NOREF) data->table_ref.release();
    return true;
  }
  return false;
}

// Native: LuaContext::Release. Explicit registry-reference release for the
// wrapper kinds that outlive a single call. Double release is a safe no-op;
// using a wrapper after release throws a clear "has been released" error.
// NOLINTNEXTLINE(readability-make-member-function-const)
val LuaContext::Release(const Args& info) {
  if (RejectIfBusy()) return val::undefined();
  if (info.Length() < 1) {
    js::ThrowTypeError("release(value) requires a Lua function, coroutine, or table reference");
    return val::undefined();
  }

  const val target = info[0];

  // Each marker is read **once** and checked for kind as well as shape
  // (CR-15 F6); only a marker minted by THIS context's runtime is trusted.
  if (js::IsFunction(target)) {
    if (auto* data = LuaFunctionDataFrom(target)) {
      if (data->runtime.get() != runtime_.get()) {
        js::ThrowError("value belongs to a different Lua context");
        return val::undefined();
      }
      if (data->func_ref.ref != LUA_NOREF) data->func_ref.release();
      return val::undefined();
    }
    js::ThrowTypeError("release(value): the function is not a Lua function reference");
    return val::undefined();
  }

  if (js::IsObject(target) && ReleaseObjectHandle(target)) {
    return val::undefined();
  }

  js::ThrowTypeError("release(value) requires a Lua function, coroutine, or table reference");
  return val::undefined();
}

// Native: LuaContext::Dispose. C2: end this context now — the retire half of
// reset() without the rebuild half. Guarded by kRetireState, which is the
// whole reason it can exist.
val LuaContext::Dispose(const Args& /*info*/) {
  // Idempotent, and tested *before* the guard: closing a closed context is a
  // no-op rather than an error.
  if (closed_) return val::undefined();
  if (RejectIfOccupied("dispose()", lua_occupancy::kRetireState)) {
    return val::undefined();
  }

  // Set first: CloseState() below fires __gc metamethods, and a finalizer that
  // re-enters the host must find a context that refuses.
  closed_ = true;
  if (closed_flag_) closed_flag_->store(true);

  // Unbind the runtime's handlers before anything can call them.
  DetachRuntimeHandlers();

  if (async_co_) {
    async_co_->release();
    async_co_.reset();
  }
  async_borrowed_ = nullptr;
  async_coro_obj_.reset();
  async_coroutine_mode_ = false;

  // Every outstanding handle refuses from here. Not re-minted, unlike
  // reset()'s — there is no successor state to hand out.
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
  return val::undefined();
}

// Native: LuaContext::ReplayRuntimeSettings. Context-level configuration, in
// the order the constructor applies it. Returns false with a JS exception
// pending. Runs under the CallScope reset() opens after the swap (CR-15 F1c).
bool LuaContext::ReplayRuntimeSettings() {
  try {
    if (!allow_bytecode_) runtime_->SetAllowBytecode(false);
    // The seal has to be re-applied, not remembered: the fresh state has stock
    // libraries, so the doors are open again on it.
    if (filesystem_denied_) runtime_->SetFilesystemAccess(false);
    if (table_as_map_) runtime_->SetPreserveTableKeys(true);
    for (const auto& path : search_paths_) runtime_->AddSearchPath(path);
    // The JS searchers too (CR-9 F3). Fresh names are minted rather than
    // reused, and the pair is registered only after the core call succeeds.
    for (const auto& searcher : searchers_) {
      const std::string name = "__searcher_" + std::to_string(next_searcher_id_++);
      runtime_->AddJsSearcher(name);
      js_callbacks_.insert_or_assign(name, searcher);
      runtime_->StoreHostFunction(name, CreateJsCallbackWrapper(name));
    }
  } catch (const std::exception& e) {
    js::ThrowError(e.what());
    return false;
  }
  return true;
}

// Native: LuaContext::ReplaySharedTables. A shared table's value lives in JS,
// so replaying it is just another push; the subscription itself is untouched.
void LuaContext::ReplaySharedTables() {
  const val self = Self();
  for (const auto& [table, name] : shared_tables_) {
    if (!IsSharedTable(table)) continue;  // defensive; validated at subscribe time
    try {
      js::SharedPush(table, self, name);
    } catch (const js::JsError& e) {
      js::Throw(e.Value());
      return;
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return;
    }
  }
}

// Native: LuaContext::Reset. Replaces the Lua state with a freshly constructed
// one carrying the same configuration, then replays the context-level
// registrations onto it. The outgoing runtime is *not* closed here: every
// handle that crossed the boundary holds a share of it, so it stays open for
// as long as some handle can still reach it — and those handles are
// invalidated all the same, because `alive_` is flipped and re-minted.
val LuaContext::Reset(const Args& /*info*/) {
  // reset() retires the lua_State, so *any* holder is a conflict.
  if (RejectIfOccupied("reset()", lua_occupancy::kRetireState)) {
    return val::undefined();
  }
  const ScopedFlag resetting(in_reset_);

  // Build the replacement first: if construction fails, the context keeps its
  // current, working state.
  std::shared_ptr<lua_core::LuaRuntime> fresh;
  try {
    fresh = std::make_shared<lua_core::LuaRuntime>(runtime_->GetConfig());
  } catch (const std::exception& e) {
    js::ThrowError(std::string("reset failed: ") + e.what());
    return val::undefined();
  }

  // Unbind the outgoing runtime before it can be destroyed: lua_close fires
  // __gc metamethods, and those must not reach members this call is about to
  // clear and repopulate.
  DetachRuntimeHandlers();

  // async_co_ is the one registry ref the context holds directly. Drop it
  // while its state is still guaranteed open.
  if (async_co_) {
    async_co_->release();  // binding-owned: this run created it
    async_co_.reset();
  }
  async_borrowed_ = nullptr;
  async_coro_obj_.reset();
  async_coroutine_mode_ = false;

  // Invalidate every outstanding handle, then mint a fresh flag for the
  // handles this state will hand out.
  if (alive_) alive_->store(false);
  alive_ = std::make_shared<std::atomic<bool>>(true);

  // Swap. This drops the context's share of the old runtime; it is destroyed
  // here iff no handle still holds one.
  runtime_ = std::move(fresh);

  // From here reset() is a *holder*, and it runs user JS while holding (the
  // callbacks object's traps, the type converters under the shared-table
  // replay). Declared after the swap, because lua_close fires the retiring
  // state's finalizers inside that statement and those are supposed to reach
  // `in_reset_`'s more specific diagnosis (CR-15 F1c).
  const CallScope call_scope(this);

  // Drop the bookkeeping that described the old state's contents. The id
  // counters are deliberately left alone: they must stay monotonic.
  js_callbacks_.clear();
  js_userdata_.clear();
  ud_method_fns_.clear();
  js_error_registry_.clear();
  registered_classes_.clear();
  class_accessors_.clear();

  InstallRuntimeHandlers();

  if (!ReplayRuntimeSettings()) return val::undefined();

  // The callbacks object and the four installed handlers are replayed here,
  // not in a helper, as natively.
  if (callbacks_ref_) {
    const val callbacks = *callbacks_ref_;
    RegisterCallbacks(callbacks);  // leaves a JS error pending on failure
    if (js::HasPending()) return val::undefined();
  }

  if (print_handler_) {
    // Take the function out first: the install reassigns the member.
    const val handler = *print_handler_;
    try {
      InstallPrintHandler(handler);
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return val::undefined();
    }
  }

  // The read handler and file reader replay for the same reason: both are
  // rewrites the fresh state does not have.
  if (read_handler_) {
    const val handler = *read_handler_;
    try {
      InstallReadHandler(handler);
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return val::undefined();
    }
  }
  if (file_reader_) {
    const val reader = *file_reader_;
    try {
      InstallFileReader(reader);
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return val::undefined();
    }
  }

  // Re-arm the debug hook on the fresh state (CR-9 F4 for the guard).
  if (debug_hook_) {
    const val hook = *debug_hook_;
    try {
      InstallDebugHook(hook, debug_hook_mask_, debug_hook_count_);
    } catch (const std::exception& e) {
      js::ThrowError(e.what());
      return val::undefined();
    }
  }

  ReplaySharedTables();
  return val::undefined();
}

// --- JS -> Lua --------------------------------------------------------------

bool LuaContext::IsOnConversionPath(const val& v) const {
  return std::any_of(conversion_path_.begin(), conversion_path_.end(),
                     [&v](const auto& seen) { return js::StrictEquals(seen, v); });
}

// Native: LuaContext::NapiToCoreInstance.
lua_core::LuaValue LuaContext::NapiToCoreInstance(const val& value, const int depth) {
  if (depth > 0) return NapiToCoreImpl(value, depth);
  JsCallbackCollectorScope collector(this);
  const ConversionPathScope path(this);
  lua_core::LuaValue result = NapiToCoreImpl(value, 0);
  collector.PropagateToParent();
  return result;
}

void LuaContext::SweepUnpushedJsCallbacks(const std::vector<std::string>& names) {
  for (const auto& name : names) {
    if (runtime_ && runtime_->EraseReclaimableIfUnpushed(name)) {
      js_callbacks_.erase(name);
    }
  }
}

// Native: LuaContext::ClassInstanceMarkerToCore. A registered class instance
// round-tripping back to Lua, recognised by its `__luaClass*` markers. nullopt
// for anything else — including a *foreign* instance, which deliberately falls
// through to a deep copy (M6).
std::optional<lua_core::LuaValue> LuaContext::ClassInstanceMarkerToCore(const val& obj) {
  if (js::Has(obj, "__luaClassRef")) {
    const val r = js::Get(obj, "__luaClassRef");
    const val cn = js::Get(obj, "__luaClassName");
    const val owner = js::Get(obj, "__luaClassOwner");
    const val owner_id = js::Get(obj, "__luaClassOwnerId");
    bool id_matches = false;
    if (js::KindOf(owner_id) == js::Kind::BigInt) {
      uint64_t stamped = 0;
      id_matches = js::BigIntToUint64(owner_id, stamped) && stamped == runtime_->Id();
    }
    // The second barrier: the owner must be one this module minted, for this
    // runtime. Natively that is a branded External wrapping the runtime's
    // address (CR-15 F6); here it is an owner object the shell maps to the
    // runtime's id, which a recycled address cannot satisfy either.
    bool owner_matches = false;
    if (const val minted = js::Host().call<val>("runtimeOwnerId", owner); !minted.isNull()) {
      uint64_t minted_id = 0;
      owner_matches = js::BigIntToUint64(minted, minted_id) && minted_id == runtime_->Id();
    }
    const bool owned = id_matches && owner_matches;
    if (owned && js::IsNumber(r) && js::IsString(cn)) {
      const int ref_id = js::Int32(r);
      if (js_userdata_.find(ref_id) != js_userdata_.end()) {
        return lua_core::LuaValue::from(lua_core::LuaUserdataRef(
          ref_id, runtime_->RawState(), /*is_opaque=*/false, LUA_NOREF,
          /*is_proxy=*/false, js::Utf8(cn)));
      }
    }
    // A foreign class instance still deep-copies, and that is deliberate (M6).
  }
  return std::nullopt;
}

// Native: LuaContext::RoundTripMarkerToCore. One of this binding's own handles
// coming back in: a table handle, a Lua-created userdata, a coroutine or a
// class instance. Each marker is read once.
std::optional<lua_core::LuaValue> LuaContext::RoundTripMarkerToCore(const val& obj) {
  // Copy the existing ref so it shares registry ownership rather than minting a
  // second owner for the same slot. Only trust the marker if it belongs to
  // THIS context's runtime — a ref index from another context would address an
  // unrelated slot in this registry.
  if (const auto* data = TaggedTableData(js::Get(obj, "_tableRef"))) {
    if (data->runtime.get() == runtime_.get()) {
      // A released handle would push registry slot LUA_NOREF (nil) silently;
      // surface it as an error instead, matching the handle methods (L2).
      if (data->table_ref.ref == LUA_NOREF) {
        throw std::runtime_error("table handle has been released");
      }
      return lua_core::LuaValue::from(lua_core::LuaTableRef(data->table_ref));
    }
    // Foreign marker: refused, as every other cross-context entry point
    // refuses one, rather than deep-copied into a table of the handle's own
    // methods (CR-17 F2).
    throw std::runtime_error("table handle belongs to a different Lua context");
  }

  // A **Lua-created** userdata handle is refused across contexts, for the
  // reason the table handle above is: its one own property is the marker, so a
  // deep copy would turn a file handle into `{}` (CR-22 F1). A JS-created
  // userdata never reaches this branch — it carries no marker.
  if (const auto* data = TaggedUserdataData(js::Get(obj, "_userdata"))) {
    if (data->runtime.get() == runtime_.get()) {
      return lua_core::LuaValue::from(lua_core::LuaUserdataRef(data->userdata_ref));
    }
    throw std::runtime_error("userdata handle belongs to a different Lua context");
  }

  // A coroutine object, refused across contexts for the same reason (CR-22
  // F2). There is deliberately no same-runtime branch: a coroutine is not a
  // value Lua can hold as a LuaValue, so within one context this object still
  // deep-copies, and only the foreign case throws.
  if (const auto* data = TaggedThreadData(js::Get(obj, "_coroutine"));
      data && data->runtime.get() != runtime_.get()) {
    throw std::runtime_error("coroutine belongs to a different Lua context");
  }

  return ClassInstanceMarkerToCore(obj);
}

// Native: LuaContext::ApplyTypeConverters. Index the vector — do NOT use a
// range-for: a converter may re-enter and register another, reallocating it
// (CR-11 F1).
std::optional<lua_core::LuaValue> LuaContext::ApplyTypeConverters(const val& value,
                                                                  const int depth) {
  // NOLINTNEXTLINE(modernize-loop-convert): see above — index, never range-for.
  for (size_t i = 0; i < type_converters_.size(); ++i) {
    const val match = type_converters_[i].first;
    const val convert = type_converters_[i].second;
    try {
      if (js::Call(match, {value}).as<bool>()) {
        return NapiToCoreInstance(js::Call(convert, {value}), depth + 1);
      }
    } catch (const js::JsError& e) {
      throw js::MakeError(js::ThrowMessage(e));
    }
  }
  return std::nullopt;
}

// Native: LuaContext::ObjectToCore.
lua_core::LuaValue LuaContext::ObjectToCore(const val& value, const int depth) {
  if (auto marked = RoundTripMarkerToCore(value)) return std::move(*marked);

  if (auto converted = ApplyTypeConverters(value, depth)) return std::move(*converted);

  // Cycle check before descending, and above ConvertBuiltinType, not below it
  // (CR-20 F2, CR-21 F2).
  if (IsOnConversionPath(value)) {
    throw std::runtime_error(
      "Value contains a circular reference, which Lua tables cannot represent; "
      "break the cycle before passing it in");
  }
  const ConversionPathEntry on_path(this, value);

  if (table_as_map_ && js::InstanceOfGlobal(value, "Map")) {
    return MapToTableRef(value, depth);
  }

  // B1: common built-in JS types (binary data, Date, Map, Set, RegExp)
  if (auto builtin = ConvertBuiltinType(value, depth,
        [this](const val& v, const int d) { return NapiToCoreInstance(v, d); })) {
    return std::move(*builtin);
  }

  if (js::IsArray(value)) {
    const auto count = js::Get(value, "length").as<uint32_t>();
    lua_core::LuaArray core_arr;
    core_arr.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
      core_arr.push_back(std::make_shared<lua_core::LuaValue>(
        NapiToCoreInstance(js::GetIndex(value, i), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(core_arr));
  }
  const val keys = js::Keys(value);
  const uint32_t count = js::Length(keys);
  lua_core::LuaTable tbl;
  for (uint32_t i = 0; i < count; i++) {
    const val key = keys[i];
    std::string key_str = js::Utf8(key);
    tbl.emplace(std::move(key_str), std::make_shared<lua_core::LuaValue>(
      NapiToCoreInstance(js::Get(value, key), depth + 1)));
  }
  return lua_core::LuaValue::from(std::move(tbl));
}

// Native: LuaContext::NapiToCoreImpl.
lua_core::LuaValue LuaContext::NapiToCoreImpl(const val& value, const int depth) {
  if (depth > lua_core::LuaRuntime::kMaxDepth) {
    throw std::runtime_error("Value nesting depth exceeds the maximum of "
      + std::to_string(lua_core::LuaRuntime::kMaxDepth) + " levels");
  }
  lua_core::detail::RequireStackHeadroom(depth);

  const js::Kind type = js::KindOf(value);
  if (type == js::Kind::Function) {
    // Register the callback (without creating a global) and return a
    // HostFunctionName so PushLuaValue materializes it as a real Lua closure.
    const std::string name = "__js_callback_" + std::to_string(next_js_callback_id_++);
    js_callbacks_.insert_or_assign(name, value);
    runtime_->RegisterReclaimableHostFunction(name, CreateJsCallbackWrapper(name));
    if (js_callback_collector_) js_callback_collector_->push_back(name);
    return lua_core::LuaValue::from(lua_core::HostFunctionName{name});
  }

  if (type == js::Kind::Undefined || type == js::Kind::Null) {
    return lua_core::LuaValue::nil();
  }
  if (type == js::Kind::Boolean) {
    return lua_core::LuaValue::from(value.as<bool>());
  }
  if (type == js::Kind::BigInt) {
    int64_t i = 0;
    if (!js::BigIntToInt64(value, i)) {
      throw std::runtime_error(
        "BigInt value is out of range for a 64-bit Lua integer");
    }
    return lua_core::LuaValue::from(i);
  }
  if (type == js::Kind::Number) {
    return NumberToCore(value.as<double>());
  }
  if (type == js::Kind::String) {
    return lua_core::LuaValue::from(js::Utf8(value));
  }
  if (type == js::Kind::Symbol) {
    throw std::runtime_error("Cannot convert a JavaScript Symbol to a Lua value");
  }

  if (type == js::Kind::Object) return ObjectToCore(value, depth);

  return lua_core::LuaValue::nil();
}

// Native: LuaContext::MapToTableRef.
lua_core::LuaValue LuaContext::MapToTableRef(const val& map, const int depth) {
  if (depth > kMaxTableDepth) {
    throw std::runtime_error(
      "Value nesting depth exceeds the maximum of " + std::to_string(kMaxTableDepth));
  }
  const val entries = js::ArrayFrom(map);
  const auto count = js::Get(entries, "length").as<uint32_t>();

  int ref = LUA_NOREF;
  try {
    ref = runtime_->CreateTable();
  } catch (const std::exception& e) {
    throw js::MakeError(e.what());
  }
  lua_core::LuaTableRef handle(ref, runtime_->RawState());
  for (uint32_t i = 0; i < count; ++i) {
    const val pair = js::GetIndex(entries, i);
    const val k = js::GetIndex(pair, 0);
    lua_core::TableKey key;
    if (!NapiToTableKey(k, key)) {
      throw std::runtime_error(
        "tableAs: 'map': a Map key that is not a string, number or boolean "
        "cannot be a Lua table key this API can address");
    }
    const auto value = std::make_shared<lua_core::LuaValue>(
      NapiToCoreInstance(js::GetIndex(pair, 1), depth + 1));
    try {
      runtime_->SetTableFieldKeyed(ref, key, value);
    } catch (const std::exception& e) {
      throw js::MakeError(e.what());
    }
  }
  return lua_core::LuaValue::from(std::move(handle));
}

// --- Lua -> JS --------------------------------------------------------------

// Native: LuaContext::ResultsToJs.
val LuaContext::ResultsToJs(const std::vector<lua_core::LuaPtr>& values) {
  if (values.empty()) return val::undefined();
  if (values.size() == 1) return CoreToNapi(*values[0]);
  val array = val::array();
  for (size_t i = 0; i < values.size(); ++i) {
    js::Set(array, std::to_string(i), CoreToNapi(*values[i]));
  }
  return array;
}

// Native: LuaContext::TableRefToMap.
val LuaContext::TableRefToMap(const lua_core::LuaTableRef& ref, const int depth) {
  if (depth > kMaxTableDepth) {
    throw js::MakeError(
      "Value nesting depth exceeds the maximum of " + std::to_string(kMaxTableDepth)
      + " while converting a Lua table to a Map. A table that contains itself "
        "cannot be materialized; read it in place with get_global_ref().");
  }

  const ConvertScope scope(convert_depth_);
  std::vector<std::pair<lua_core::LuaPtr, lua_core::LuaPtr>> pairs;
  try {
    pairs = runtime_->TablePairs(ref.ref);
  } catch (const std::exception& e) {
    throw js::MakeError(e.what());
  }
  val entries = val::array();
  for (size_t i = 0; i < pairs.size(); ++i) {
    val entry = val::array();
    js::Set(entry, "0", CoreToNapi(*pairs[i].first));

    // Nested plain tables recurse as Maps; everything else goes through the
    // ordinary conversion.
    const lua_core::LuaValue& value = *pairs[i].second;
    if (std::holds_alternative<lua_core::LuaTableRef>(value.value)) {
      const auto& nested = std::get<lua_core::LuaTableRef>(value.value);
      if (!runtime_->RefHasMetatable(nested.ref)) {
        js::Set(entry, "1", TableRefToMap(nested, depth + 1));
        js::Set(entries, std::to_string(i), entry);
        continue;
      }
    }
    js::Set(entry, "1", CoreToNapi(value));
    js::Set(entries, std::to_string(i), entry);
  }

  const val ctor = js::Global("Map");
  if (!js::IsFunction(ctor)) {
    throw js::MakeError("tableAs: 'map' needs the global Map constructor, "
                        "which is missing or has been replaced");
  }
  return js::Construct(ctor, {entries});
}

// Native: LuaContext::CoreToNapi.
val LuaContext::CoreToNapi(const lua_core::LuaValue& value) {
  val result = CoreToNapiBuiltin(value);
  if (from_lua_converters_.empty()) return result;
  if (js::KindOf(result) != js::Kind::Object) return result;

  // NOLINTNEXTLINE(modernize-loop-convert): index, never range-for (CR-11 F1).
  for (size_t i = 0; i < from_lua_converters_.size(); ++i) {
    const val match = from_lua_converters_[i].first;
    const val convert = from_lua_converters_[i].second;
    try {
      if (js::Call(match, {result}).as<bool>()) {
        return js::Call(convert, {result});
      }
    } catch (const js::JsError& e) {
      throw js::MakeError(js::ThrowMessage(e));
    }
  }
  return result;
}

// Native: LuaContext::IntegerToNapi.
val LuaContext::IntegerToNapi(const int64_t v) {
  constexpr int64_t kMaxSafeInteger = 9007199254740991LL;  // 2^53 - 1
  if (v > kMaxSafeInteger || v < -kMaxSafeInteger) {
    return js::BigInt(v);
  }
  return val(static_cast<double>(v));
}

// Native: LuaContext::StringToNapi.
val LuaContext::StringToNapi(const std::string& v) const {
  if (binary_strings_) return js::Uint8Array(v);
  return js::String(v);
}

// Native: LuaContext::ArrayToNapi.
val LuaContext::ArrayToNapi(const lua_core::LuaArray& v) {
  const ConvertScope scope(convert_depth_);
  val arr = val::array();
  for (size_t i = 0; i < v.size(); ++i) {
    js::Set(arr, std::to_string(i), CoreToNapi(*v[i]));
  }
  return arr;
}

// Native: LuaContext::TableToNapi.
val LuaContext::TableToNapi(const lua_core::LuaTable& v) {
  const ConvertScope scope(convert_depth_);
  val obj = val::object();
  for (const auto& [k, value] : v) {
    js::Set(obj, k, CoreToNapi(*value));
  }
  return obj;
}

// Native: LuaContext::RefForThisRuntime. A ref from a state this context has
// already retired cannot be made valid, so the only correct handle is a dead
// one (CR-17 F1); the core's own share still unrefs it against the right state.
template <typename RefT>
RefT LuaContext::RefForThisRuntime(const RefT& ref) const {
  if (ref.L && lua_core::detail::OwningRuntime(ref.L) == runtime_.get()) return ref;
  RefT dead = ref;
  dead.release();  // drops only this copy's share
  return dead;
}

// Native: LuaContext::FunctionRefToNapi. A Lua function, as a callable JS
// function that owns its registry ref. The shell builds the function, gives it
// the hidden `__luaFnOwner` that is its brand, and registers the handle for
// `delete()` when the function is collected.
val LuaContext::FunctionRefToNapi(const lua_core::LuaFunctionRef& v) {
  // Held by unique_ptr until the shell's handle is the owner.
  auto data = std::make_unique<LuaFunctionData>(
    runtime_, RefForThisRuntime(v), this, Liveness());
  LuaFunctionData* data_ptr = data.get();
  val fn = js::Host().call<val>("luaFunction", val(data_ptr, emscripten::allow_raw_pointers()),
                                shell_state_);
  // NOLINTNEXTLINE(bugprone-unused-return-value): the shell's handle owns it now
  (void)data.release();
  return fn;
}

// Native: LuaContext::UserdataRefToNapi. A userdata: the original JS object,
// or an opaque handle for a Lua-created one.
val LuaContext::UserdataRefToNapi(const lua_core::LuaUserdataRef& v) {
  if (!v.opaque) {
    // JS-created userdata - return the original JS object
    const auto it = js_userdata_.find(v.ref_id);
    if (it != js_userdata_.end()) {
      return it->second.object;
    }
    return val::null();
  }
  // Lua-created userdata - an opaque handle for the round trip. Held by
  // unique_ptr until the shell's handle is the owner.
  auto data = std::make_unique<LuaUserdataData>(runtime_, RefForThisRuntime(v));
  val handle = js::Host().call<val>("userdataHandle",
                                    val(data.get(), emscripten::allow_raw_pointers()));
  // NOLINTNEXTLINE(bugprone-unused-return-value): the shell's handle owns it now
  (void)data.release();
  return handle;
}

// Native: LuaContext::TableRefToNapi. A table kept by reference: a Map under
// `tableAs: 'map'`, otherwise a Proxy that preserves the Lua metamethods. The
// shell builds the Proxy — its target carrying `_tableRef`, its five traps each
// rooting the owner (H3) — around the struct made here.
val LuaContext::TableRefToNapi(const lua_core::LuaTableRef& v) {
  if (table_as_map_ && !runtime_->RefHasMetatable(v.ref)) {
    return TableRefToMap(v, 0);
  }

  auto data = std::make_unique<LuaTableRefData>(
      runtime_, RefForThisRuntime(v), this, Liveness());
  LuaTableRefData* data_ptr = data.get();
  val proxy = js::Host().call<val>("tableProxy", val(data_ptr, emscripten::allow_raw_pointers()),
                                   shell_state_);
  // NOLINTNEXTLINE(bugprone-unused-return-value): the shell's handle owns it now
  (void)data.release();
  return proxy;
}

// Native: LuaContext::CoreToNapiBuiltin.
val LuaContext::CoreToNapiBuiltin(const lua_core::LuaValue& value) {
  return std::visit(
      [&](const auto& v) -> val {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, std::monostate>) {
          return val::null();
        } else if constexpr (std::is_same_v<T, bool> || std::is_same_v<T, double>) {
          return val(v);  // a JS boolean, or a JS number
        } else if constexpr (std::is_same_v<T, int64_t>) {
          return IntegerToNapi(v);
        } else if constexpr (std::is_same_v<T, std::string>) {
          return StringToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaArray>) {
          return ArrayToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaTable>) {
          return TableToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaFunctionRef>) {
          return FunctionRefToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaThreadRef>) {
          // A coroutine object carrying the thread reference.
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
          if (it != js_callbacks_.end()) return it->second;
          return val::undefined();
        }
        return val::undefined();
      },
      value.value);
}

}  // namespace lua_wasm

EMSCRIPTEN_BINDINGS(lua_native) {
  using lua_wasm::LuaContext;
  emscripten::function("attachHost", &js::AttachHost);
  lua_core::detail::stack_headroom = &js::StackHeadroom;
  emscripten::function("entryCounterAddress", &LuaContext::EntryCounterAddress);
  emscripten::class_<LuaContext>("LuaContext")
    .class_function("create", &LuaContext::Create, emscripten::return_value_policy::take_ownership())
    .function("execute_script", &lua_wasm::Thunk<&LuaContext::ExecuteScript>)
    .function("set_global", &lua_wasm::Thunk<&LuaContext::SetGlobal>)
    .function("get_global", &lua_wasm::Thunk<&LuaContext::GetGlobal>)
    .function("call", &lua_wasm::Thunk<&LuaContext::Call>)
    .function("pcall", &lua_wasm::Thunk<&LuaContext::Pcall>)
    .function("create_table", &lua_wasm::Thunk<&LuaContext::CreateTableMethod>)
    .function("get_global_ref", &lua_wasm::Thunk<&LuaContext::GetGlobalRef>)
    .function("create_environment", &lua_wasm::Thunk<&LuaContext::CreateEnvironment>)
    .function("execute_script_in", &lua_wasm::Thunk<&LuaContext::ExecuteScriptIn>)
    .function("set_userdata", &lua_wasm::Thunk<&LuaContext::SetUserdata>)
    .function("set_metatable", &lua_wasm::Thunk<&LuaContext::SetMetatable>)
    .function("register_class", &lua_wasm::Thunk<&LuaContext::RegisterClass>)
    .function("register_type_converter", &lua_wasm::Thunk<&LuaContext::RegisterTypeConverter>)
    .function("register_from_lua_converter",
              &lua_wasm::Thunk<&LuaContext::RegisterFromLuaConverter>)
    .function("execute_file", &lua_wasm::Thunk<&LuaContext::ExecuteFile>)
    .function("create_coroutine", &lua_wasm::Thunk<&LuaContext::CreateCoroutine>)
    .function("resume", &lua_wasm::Thunk<&LuaContext::ResumeCoroutine>)
    .function("close", &lua_wasm::Thunk<&LuaContext::CloseCoroutine>)
    .function("resume_async", &lua_wasm::Thunk<&LuaContext::ResumeAsync>)
    .function("execute_script_async", &lua_wasm::Thunk<&LuaContext::ExecuteScriptAsync>)
    .function("execute_file_async", &lua_wasm::Thunk<&LuaContext::ExecuteFileAsync>)
    .function("execute_async", &lua_wasm::Thunk<&LuaContext::ExecuteAsync>)
    .function("call_async", &lua_wasm::Thunk<&LuaContext::CallAsync>)
    .function("cancel", &lua_wasm::Thunk<&LuaContext::Cancel>)
    .function("is_busy", &lua_wasm::Thunk<&LuaContext::IsBusyMethod>)
    .function("add_search_path", &lua_wasm::Thunk<&LuaContext::AddSearchPath>)
    .function("register_module", &lua_wasm::Thunk<&LuaContext::RegisterModule>)
    .function("add_searcher", &lua_wasm::Thunk<&LuaContext::AddSearcher>)
    .function("compile", &lua_wasm::Thunk<&LuaContext::Compile>)
    .function("compile_file", &lua_wasm::Thunk<&LuaContext::CompileFile>)
    .function("load_bytecode", &lua_wasm::Thunk<&LuaContext::LoadBytecode>)
    .function("set_print_handler", &lua_wasm::Thunk<&LuaContext::SetPrintHandler>)
    .function("set_read_handler", &lua_wasm::Thunk<&LuaContext::SetReadHandler>)
    .function("set_file_reader", &lua_wasm::Thunk<&LuaContext::SetFileReader>)
    .function("set_hook", &lua_wasm::Thunk<&LuaContext::SetHook>)
    .function("remove_hook", &lua_wasm::Thunk<&LuaContext::RemoveHook>)
    .function("get_stack", &lua_wasm::Thunk<&LuaContext::GetStack>)
    .function("get_locals", &lua_wasm::Thunk<&LuaContext::GetLocals>)
    .function("get_memory_usage", &lua_wasm::Thunk<&LuaContext::GetMemoryUsage>)
    .function("info", &lua_wasm::Thunk<&LuaContext::Info>)
    .function("release", &lua_wasm::Thunk<&LuaContext::Release>)
    .function("dispose", &lua_wasm::Thunk<&LuaContext::Dispose>)
    .function("reset", &lua_wasm::Thunk<&LuaContext::Reset>)
    .function("gc", &lua_wasm::Thunk<&LuaContext::GC>)
    .function("subscribe_shared", &lua_wasm::Thunk<&LuaContext::SubscribeShared>);
  // None of these is constructible from JS: each is minted by the conversion
  // that hands its JS face to the shell.
  using lua_wasm::HandleEntry;
  using lua_wasm::LuaFunctionData;
  using lua_wasm::LuaTableIterState;
  using lua_wasm::LuaTableRefData;
  emscripten::class_<LuaFunctionData>("LuaFunctionHandle")
    .function("call", &HandleEntry<&lua_wasm::LuaFunctionCallbackStatic, const LuaFunctionData>);
  emscripten::class_<LuaTableRefData>("LuaTableHandle")
    .function("get", &HandleEntry<&lua_wasm::TableHandleGet, const LuaTableRefData>)
    .function("get_ref", &HandleEntry<&lua_wasm::TableHandleGetRef, const LuaTableRefData>)
    .function("set", &HandleEntry<&lua_wasm::TableHandleSet, const LuaTableRefData>)
    .function("has", &HandleEntry<&lua_wasm::TableHandleHas, const LuaTableRefData>)
    .function("length", &HandleEntry<&lua_wasm::TableHandleLength, const LuaTableRefData>)
    .function("pairs", &HandleEntry<&lua_wasm::TableHandlePairs, const LuaTableRefData>)
    .function("ipairs", &HandleEntry<&lua_wasm::TableHandleIPairs, const LuaTableRefData>)
    .function("keys", &HandleEntry<&lua_wasm::TableHandleKeys, const LuaTableRefData>)
    .function("release", &HandleEntry<&lua_wasm::TableHandleRelease, LuaTableRefData>)
    .function("iterator", &HandleEntry<&lua_wasm::TableHandleSymbolIterator, const LuaTableRefData>)
    .function("trapGet", &HandleEntry<&lua_wasm::TableRefGetTrap, const LuaTableRefData>)
    .function("trapSet", &HandleEntry<&lua_wasm::TableRefSetTrap, const LuaTableRefData>)
    .function("trapHas", &HandleEntry<&lua_wasm::TableRefHasTrap, const LuaTableRefData>)
    .function("trapOwnKeys", &HandleEntry<&lua_wasm::TableRefOwnKeysTrap, const LuaTableRefData>)
    .function("trapGetOwnPropertyDescriptor",
              &HandleEntry<&lua_wasm::TableRefGetOwnPropertyDescriptorTrap, const LuaTableRefData>);
  // No methods: the handle for a Lua-created userdata only round-trips.
  emscripten::class_<lua_wasm::LuaUserdataData>("LuaUserdataHandle");
  emscripten::class_<lua_wasm::LuaThreadData>("LuaThreadHandle");
  using lua_wasm::LuaContextBinding;
  emscripten::class_<LuaContextBinding>("LuaContextBinding")
    .function("iterator", &HandleEntry<&lua_wasm::CoroSymbolIterator, const LuaContextBinding>)
    .function("asyncIterator",
              &HandleEntry<&lua_wasm::CoroSymbolAsyncIterator, const LuaContextBinding>);
  using lua_wasm::LuaCoroIterState;
  emscripten::class_<LuaCoroIterState>("LuaCoroIterator")
    .function("next", &HandleEntry<&lua_wasm::CoroIteratorNext, LuaCoroIterState>)
    .function("asyncNext", &HandleEntry<&lua_wasm::CoroAsyncIteratorNext, LuaCoroIterState>)
    .function("map", &HandleEntry<&lua_wasm::CoroAsyncNextMap, LuaCoroIterState>)
    .function("return", &HandleEntry<&lua_wasm::CoroIteratorReturn, LuaCoroIterState>);
  using lua_wasm::AwaitCookie;
  emscripten::class_<AwaitCookie>("LuaAwaitCookie")
    .function("resolve", &HandleEntry<&lua_wasm::OnAwaitResolveStatic, AwaitCookie>)
    .function("reject", &HandleEntry<&lua_wasm::OnAwaitRejectStatic, AwaitCookie>);
  using lua_wasm::LuaWorkerRun;
  emscripten::class_<LuaWorkerRun>("LuaWorkerRun")
    .function("run", &HandleEntry<&lua_wasm::WorkerRun, LuaWorkerRun>)
    .function("finish", &HandleEntry<&lua_wasm::WorkerFinish, LuaWorkerRun>)
    .function("stackTop", &lua_wasm::WorkerStackTop)
    .function("stackBottom", &lua_wasm::WorkerStackBottom)
    .function("address", &lua_wasm::WorkerAddress)
    .class_function("executeEntry", &lua_wasm::WorkerExecuteEntryIndex)
    .class_function("setPause", &js::SetPause);
  emscripten::class_<LuaTableIterState>("LuaTableIterator")
    .function("next", &HandleEntry<&lua_wasm::TableIteratorNext, LuaTableIterState>);
}
