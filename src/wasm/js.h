// The WASM binding's view of JavaScript: what `node-addon-api` is to the
// native binding, written over `emscripten::val`.
//
// It exists to hold one rule in one place (`docs/reviews/WASM-TARGET-PLAN.md` D2,
// rule 2): **a JavaScript exception never unwinds through a WASM frame.** Any
// operation that can run user JS — a property read (a getter, a Proxy trap), a
// call, `String(v)`, `instanceof` — goes through a function on the shell's
// `host` object that catches, and comes back here as a `JsError`. `JsError` is
// a C++ exception and derives from `std::exception`, which is exactly what
// `Napi::Error` is under NODE_ADDON_API_CPP_EXCEPTIONS; the ported code's
// `catch (const Napi::Error&)` and `catch (const std::exception&)` sites keep
// their shape and their meaning.
//
// The other half of the N-API model is the *pending* exception:
// `Napi::Error::New(...).ThrowAsJavaScriptException(); return env.Undefined();`
// becomes `js::ThrowError(...); return val::undefined();`, and the entry-point
// wrapper in lua-wasm.cpp turns a pending exception into the sentinel the
// shell rethrows.
//
// Operations that cannot run user JS (`typeof`, `Array.isArray`, the brand
// checks) call the host directly, with no guard.

#pragma once

#include <emscripten/val.h>

#include <cstdint>
#include <exception>
#include <string>
#include <utility>
#include <vector>

namespace js {

using emscripten::val;

// napi_valuetype. `External` is one of the shell's *owner* objects — what
// stands here for an N-API External (shell.js, "handles"). It is reported as
// its own kind for the reason N-API reports one: an External is not an object
// to any check in the binding, and converts to nil rather than to a table.
enum class Kind : int {
  Undefined = 0,
  Null = 1,
  Boolean = 2,
  Number = 3,
  String = 4,
  Symbol = 5,
  Function = 6,
  BigInt = 7,
  Object = 8,
  External = 9,
};

// What a `Kind::Object` is, for the conversion's built-in branches.
enum class ObjectKind : int {
  Plain = 0,
  Array = 1,
  Binary = 2,  // any ArrayBuffer view, or an ArrayBuffer
  Date = 3,
};

enum class ErrorType : int { Error = 0, TypeError = 1, RangeError = 2 };

// The shell's `host` object, attached once before anything else runs.
void AttachHost(val host);
const val& Host();
const val& FailedSentinel();

// A JS value that was thrown, as a C++ exception. `what()` is the thrown
// value's `.message` when that is a string and empty otherwise — the same
// answer `Napi::Error::what()` gives, including for `throw 'boom'`.
class JsError : public std::exception {
 public:
  explicit JsError(val value);
  [[nodiscard]] const char* what() const noexcept override { return message_.c_str(); }
  [[nodiscard]] const val& Value() const { return value_; }
  [[nodiscard]] const std::string& Message() const { return message_; }

 private:
  val value_;
  std::string message_;
};

// `Napi::Error::New(env, message)` as a throwable C++ exception.
JsError MakeError(const std::string& message, ErrorType type = ErrorType::Error);
val NewErrorValue(const std::string& message, ErrorType type = ErrorType::Error);

// The message for a caught JsError: its `.message`, else the thrown value's
// string form, else a fixed text. Never throws. (Native: JsThrowMessage.)
std::string ThrowMessage(const JsError& e);

// --- the pending exception -------------------------------------------------

void Throw(const val& value);
void ThrowError(const std::string& message);
void ThrowTypeError(const std::string& message);
void ThrowRangeError(const std::string& message);
[[nodiscard]] bool HasPending();
// Clears the flag; the value itself is already with the shell.
void ClearPending();

// --- classification: none of these runs user JS -----------------------------

Kind KindOf(const val& value);
ObjectKind ObjectKindOf(const val& value);
// Napi::Value::IsObject(): an object or a function, and not null.
bool IsObject(const val& value);
bool IsFunction(const val& value);
bool IsArray(const val& value);
bool IsString(const val& value);
bool IsNumber(const val& value);
bool IsBoolean(const val& value);
bool IsNullish(const val& value);
bool IsPromise(const val& value);
// `Napi::Value::IsBuffer()`: any ArrayBuffer view, and not an ArrayBuffer.
bool IsBufferView(const val& value);

// --- guarded operations: each throws JsError if user JS threw ---------------

val Get(const val& object, const char* key);
val Get(const val& object, const std::string& key);
val Get(const val& object, const val& key);
val GetIndex(const val& object, uint32_t index);
bool Has(const val& object, const char* key);
void Set(const val& object, const std::string& key, const val& value);
// Enumerable string keys including inherited ones — napi_get_property_names.
val Keys(const val& object);
val Call(const val& function, const std::vector<val>& args);
// `Napi::Function::Call(recv, args)`.
val CallWithThis(const val& function, const val& receiver, const std::vector<val>& args);
// Native: DefineHiddenProp. A non-enumerable, non-configurable data property.
// Guarded because the object is the caller's: a frozen one refuses, and a
// Proxy's `defineProperty` trap is user code.
void DefineHidden(const val& object, const char* key, const val& value, bool writable = true);
val Construct(const val& constructor, const std::vector<val>& args);
// The abstract ToString: throws for a Symbol, runs `toString`/`@@toPrimitive`.
std::string ToString(const val& value);
bool InstanceOfGlobal(const val& value, const char* constructor_name);
// A shared table publishing its value into `context` as the global `name`,
// through the context's public `set_global`; `SharedSubscribe` also records
// the context as a subscriber. (Native: SharedTable::Subscribe / PushTo.)
void SharedSubscribe(const val& table, const val& context, const std::string& name);
void SharedPush(const val& table, const val& context, const std::string& name);
// `globalThis.Array.from(value)`, read off the global at call time.
val ArrayFrom(const val& value);
val Global(const char* name);

// --- values -------------------------------------------------------------------

uint32_t Length(const val& array_like);
// A JS string as UTF-8 bytes; a lone surrogate becomes U+FFFD, as it does in
// `napi_get_value_string_utf8`.
std::string Utf8(const val& string);
// UTF-8 bytes as a JS string; an invalid sequence becomes U+FFFD, as it does
// in `napi_create_string_utf8`. Embedded NULs and a leading BOM survive.
val String(const std::string& utf8);
// The bytes of an ArrayBuffer view or an ArrayBuffer.
std::string Bytes(const val& binary);
// A fresh Uint8Array holding a copy of `bytes`.
val Uint8Array(const std::string& bytes);
double DateValue(const val& date);
// `napi_get_value_int32` of a JS number: the low 32 bits, 0 if not finite.
int32_t Int32(const val& number);
// False if the BigInt does not fit an int64 exactly.
bool BigIntToInt64(const val& bigint, int64_t& out);
bool BigIntToUint64(const val& bigint, uint64_t& out);
val BigInt(int64_t value);
bool StrictEquals(const val& a, const val& b);

}  // namespace js
