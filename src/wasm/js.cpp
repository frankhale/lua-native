// See js.h. Every function here is a thin call onto the shell's `host` object
// (`src/wasm/shell.js`), which is where the `try`/`catch` actually lives.

#include "js.h"

#include <emscripten/bind.h>

#include <utility>

namespace js {

namespace {

// Both are `undefined` until AttachHost runs, which the shell does before it
// exports anything.
struct HostState {
  val host;
  val failed;
};

HostState& State() {
  static HostState state;
  return state;
}

bool& PendingFlag() {
  static bool pending = false;
  return pending;
}

// A guarded host function returns the shell's sentinel instead of throwing.
// The thrown value is fetched and rethrown here as a C++ exception.
val Guard(val result) {
  if (result.strictlyEquals(FailedSentinel())) {
    throw JsError(Host().call<val>("takeThrown"));
  }
  return result;
}

val MemoryView(const std::string& bytes) {
  return val(emscripten::typed_memory_view(
      bytes.size(), reinterpret_cast<const unsigned char*>(bytes.data())));
}

// Copies a JS Uint8Array into a std::string.
std::string CopyOut(const val& bytes) {
  const auto length = bytes["length"].as<uint32_t>();
  std::string out(length, '\0');
  if (length != 0) {
    val(emscripten::typed_memory_view(length, reinterpret_cast<unsigned char*>(out.data())))
        .call<void>("set", bytes);
  }
  return out;
}

// A std::string naming a property stops at its first NUL. That is not a choice
// made here: the native binding names a property through
// `napi_get/set_named_property`, which take a C string, so a Lua key "a\0b"
// has always addressed the JS property "a" — a documented loss (LIMITATIONS
// §5) that `strictConversion` refuses and the suite pins. Keeping the whole
// key would be a different API.
std::string PropertyName(const std::string& key) {
  return key.substr(0, key.find('\0'));
}

}  // namespace

void AttachHost(val host) {
  State().failed = host["failed"];
  State().host = std::move(host);
}

const val& Host() { return State().host; }
const val& FailedSentinel() { return State().failed; }

JsError::JsError(val value) : value_(std::move(value)) {
  // `errorMessage` cannot throw: it catches a hostile `message` getter itself.
  message_ = Utf8(Host().call<val>("errorMessage", value_));
}

val NewErrorValue(const std::string& message, const ErrorType type) {
  return Host().call<val>("newError", static_cast<int>(type), String(message));
}

JsError MakeError(const std::string& message, const ErrorType type) {
  return JsError(NewErrorValue(message, type));
}

std::string ThrowMessage(const JsError& e) {
  if (!e.Message().empty()) return e.Message();
  // String(v) runs user code (a hostile `toString`/`Symbol.toPrimitive`) and is
  // on an error path, so it cannot be allowed to throw again.
  try {
    return ToString(e.Value());
  } catch (...) {
    return "JavaScript callback threw a value that could not be converted to a string";
  }
}

void Throw(const val& value) {
  Host().call<void>("setPending", value);
  PendingFlag() = true;
}

void ThrowError(const std::string& message) { Throw(NewErrorValue(message, ErrorType::Error)); }
void ThrowTypeError(const std::string& message) { Throw(NewErrorValue(message, ErrorType::TypeError)); }
void ThrowRangeError(const std::string& message) { Throw(NewErrorValue(message, ErrorType::RangeError)); }
bool HasPending() { return PendingFlag(); }
void ClearPending() { PendingFlag() = false; }

Kind KindOf(const val& value) { return static_cast<Kind>(Host().call<int>("kind", value)); }

ObjectKind ObjectKindOf(const val& value) {
  return static_cast<ObjectKind>(Host().call<int>("objectKind", value));
}

bool IsObject(const val& value) {
  const Kind kind = KindOf(value);
  return kind == Kind::Object || kind == Kind::Function;
}

bool IsFunction(const val& value) { return KindOf(value) == Kind::Function; }
bool IsArray(const val& value) { return value.isArray(); }
bool IsString(const val& value) { return value.isString(); }
bool IsNumber(const val& value) { return value.isNumber(); }
bool IsBoolean(const val& value) { return value.isTrue() || value.isFalse(); }
bool IsNullish(const val& value) { return value.isUndefined() || value.isNull(); }
bool IsPromise(const val& value) { return Host().call<bool>("isPromise", value); }
bool IsBufferView(const val& value) { return Host().call<bool>("isBufferView", value); }

val Get(const val& object, const char* key) {
  return Guard(Host().call<val>("get", object, val(key)));
}

val Get(const val& object, const std::string& key) {
  return Guard(Host().call<val>("get", object, String(PropertyName(key))));
}

val Get(const val& object, const val& key) { return Guard(Host().call<val>("get", object, key)); }

val GetIndex(const val& object, const uint32_t index) {
  return Guard(Host().call<val>("get", object, val(index)));
}

bool Has(const val& object, const char* key) {
  return Guard(Host().call<val>("has", object, val(key))).as<bool>();
}

void Set(const val& object, const std::string& key, const val& value) {
  Guard(Host().call<val>("set", object, String(PropertyName(key)), value));
}

val Keys(const val& object) { return Guard(Host().call<val>("keys", object)); }

val Call(const val& function, const std::vector<val>& args) {
  return Guard(Host().call<val>("call", function, val::array(args)));
}

val CallWithThis(const val& function, const val& receiver, const std::vector<val>& args) {
  return Guard(Host().call<val>("callWith", function, receiver, val::array(args)));
}

void DefineHidden(const val& object, const char* key, const val& value, const bool writable) {
  Guard(Host().call<val>("defineHidden", object, val(key), value, writable));
}

val Construct(const val& constructor, const std::vector<val>& args) {
  return Guard(Host().call<val>("construct", constructor, val::array(args)));
}

std::string ToString(const val& value) {
  return Utf8(Guard(Host().call<val>("toString", value)));
}

bool InstanceOfGlobal(const val& value, const char* constructor_name) {
  return Guard(Host().call<val>("instanceOfGlobal", value, val(constructor_name))).as<bool>();
}

void SharedSubscribe(const val& table, const val& context, const std::string& name) {
  Guard(Host().call<val>("sharedSubscribe", table, context, String(name)));
}

void SharedPush(const val& table, const val& context, const std::string& name) {
  Guard(Host().call<val>("sharedPush", table, context, String(name)));
}

val ArrayFrom(const val& value) { return Guard(Host().call<val>("arrayFrom", value)); }
val Global(const char* name) { return Guard(Host().call<val>("global", val(name))); }

uint32_t Length(const val& array_like) { return array_like["length"].as<uint32_t>(); }

// The four below run no user code and are guarded all the same: each can be
// refused by the engine (a string past its longest, an allocation, a detached
// buffer), and that must arrive as an error, not unwind the module.
std::string Utf8(const val& string) { return CopyOut(Guard(Host().call<val>("utf8", string))); }

val String(const std::string& utf8) {
  return Guard(Host().call<val>("string", MemoryView(utf8)));
}

std::string Bytes(const val& binary) {
  return CopyOut(Guard(Host().call<val>("bytesView", binary)));
}

val Uint8Array(const std::string& bytes) {
  return Guard(Host().call<val>("newBytes", MemoryView(bytes)));
}

double DateValue(const val& date) { return Host().call<double>("dateValue", date); }

int32_t Int32(const val& number) { return Host().call<int32_t>("int32", number); }

bool BigIntToInt64(const val& bigint, int64_t& out) {
  if (!Host().call<bool>("fitsInt64", bigint)) return false;
  out = bigint.as<int64_t>();
  return true;
}

bool BigIntToUint64(const val& bigint, uint64_t& out) {
  if (!Host().call<bool>("fitsUint64", bigint)) return false;
  out = bigint.as<uint64_t>();
  return true;
}

val BigInt(const int64_t value) { return val(value); }

bool StrictEquals(const val& a, const val& b) { return a.strictlyEquals(b); }

}  // namespace js
