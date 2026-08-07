#pragma once

#include <napi.h>
#include <atomic>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <memory>
#include <utility>
#include <vector>
#include <optional>

#include "core/lua-runtime.h"

class LuaContext;

// --- Marker-External type tags (CR-15 F6) -----------------------------------
//
// The addon hands JS several hidden "marker" properties whose value is a
// `Napi::External` wrapping one of the *Data structs below: `_tableRef`,
// `_userdata`, `_coroutine`, `__luaFnOwner`, `__luaClassOwner`. Each read site
// used to validate only `IsExternal()` and then a
// `data->runtime.get() == runtime.get()` identity comparison.
//
// **That pair checks provenance but not *kind*.** JS cannot mint an External —
// but it can take a genuine one the addon handed out and present it under a
// different marker name, e.g. `set_global('x', { _tableRef: coro._coroutine })`.
// The External is real, and the runtime comparison passes because it is the
// *same context's* object; only the C++ type is wrong. Every one of the four
// *Data structs begins with a `shared_ptr<LuaRuntime>`, so the identity check
// reads the right field of the wrong struct and agrees.
//
// Reached that way, `type(x)` in Lua reported `"thread"` for a value pushed
// through the table-ref path. It did not crash, and the reason is worth writing
// down because it is not a defence: the reads that would have been wild land on
// a pointer `MakeRegistryOwner` always initialises to `nullptr`, and
// `LuaFunctionRef` and `LuaTableRef` happen to be layout-identical. Two
// accidents of struct layout, either of which a future field reordering
// removes.
//
// N-API type tags are the mechanism built for exactly this: a 128-bit brand
// applied at mint time and checked before the payload is read. `CheckTypeTag`
// returns false for an untagged or differently-tagged External rather than
// throwing, so every site fails closed the way it already tried to.
//
// Tag one kind per struct, and tag it at **every** mint site — a kind whose
// second mint site forgets the tag fails closed at the read, which looks like a
// released handle and is very hard to trace back. `grep -n 'External<Lua'` is
// the generator for the mint list; `grep -n 'TaggedData<'` is the read list.
//
// Only the dereferenced markers are tagged. `_tableOwner`, `__coroIterOwner`,
// `__coroBindingOwner` and `__cookie` are GC roots that are written and never
// read back — their payload reaches the callbacks through `info.Data()`, which
// is set natively and is not JS-reachable — so there is no read to guard.
// The literals below are **UUIDs, and the opacity is the point.** `napi_type_tag`
// is `{uint64_t lower; uint64_t upper}` — a 128-bit value compared bitwise — so
// there is nothing to derive it from; Node's own documentation specifies a
// generated UUID and its example is this same shape. Two properties are load-
// bearing and neither survives a "cleaner" scheme:
//
//   * **Stable.** The tag is written onto the JS object at mint and compared at
//     read, so it must be the same value at both ends. Anything derived from an
//     address is out — and it is out for this codebase's own reason: CR-14 F2
//     was an identity token that was a raw pointer, and pointers get recycled.
//   * **Globally unique, not just locally distinct.** The threat is a foreign
//     External reaching one of our read sites. Another addon that type-tags its
//     own objects and happens to collide would be accepted and reinterpreted —
//     exactly the confusion this exists to stop. A hash of `"LuaTableRefData"`
//     would be self-documenting and locally distinct, and would give that
//     property up.
//
// Generated with `uuidgen`; regenerate the same way if a sixth kind is added.
// Changing an existing one is harmless (tags live only for the process), but
// pointless.
namespace lua_tags {
inline constexpr napi_type_tag kTableRefData = {.lower = 0x6698902f38bc485d, .upper = 0x9b90643c0fd512d3};
inline constexpr napi_type_tag kFunctionData = {.lower = 0x667131e920a749af, .upper = 0xbb1c4846120ea2f7};
inline constexpr napi_type_tag kUserdataData = {.lower = 0xa8b9ebcda2c3425c, .upper = 0xb7e95102192dfc6d};
inline constexpr napi_type_tag kThreadData   = {.lower = 0x03c9d2fd69544592, .upper = 0x96fef3e10b2ceb0b};
inline constexpr napi_type_tag kRuntimeOwner = {.lower = 0x4407ac2239054ac1, .upper = 0xbd118c5dfb000daf};
// The SharedTable ObjectWrap itself, not a marker External (CR-20 follow-up).
// `InstanceOf` consults Symbol.hasInstance and is user-defeatable, and
// `napi_unwrap` is **not** a type check — it returns whatever pointer was
// attached, so a *different* ObjectWrap subclass unwraps successfully and its
// pointer is reinterpreted. That pair therefore provides no type safety at all
// once the forgery is in place: a LuaContext was accepted as a shared table and
// the process aborted. This is CR-15 F6's lesson — provenance is not kind —
// applied to an ObjectWrap instead of an External.
inline constexpr napi_type_tag kSharedTable  = {0x3865e102fe364b62, 0x9aebe69347984e92};

// Distinctness is the whole mechanism, and a copy-paste that repeated a value
// would silently re-merge two kinds — while every regression pin kept passing,
// because each one checks a single specific wrong pairing rather than all ten.
// That is precisely the failure CR-15 F3 is about (an invariant believed rather
// than checked), so check it, and check it exhaustively rather than by reading.
constexpr bool SameTag(const napi_type_tag& a, const napi_type_tag& b) {
  return a.lower == b.lower && a.upper == b.upper;
}
constexpr bool AllTagsDistinct() {
  constexpr napi_type_tag all[] = {kTableRefData, kFunctionData, kUserdataData,
                               kThreadData, kRuntimeOwner, kSharedTable};
  constexpr size_t n = std::size(all);
  for (size_t i = 0; i < n; ++i) {
    for (size_t j = i + 1; j < n; ++j) {
      if (SameTag(all[i], all[j])) return false;
    }
  }
  return true;
}
static_assert(AllTagsDistinct(),
              "marker type tags must be pairwise distinct: a repeated value "
              "silently merges two kinds and disables the branding for them");
}  // namespace lua_tags

// --- Occupancy: who currently holds a context's lua_State --------------------
//
// **Why this exists.** A Lua state may be touched by one thing at a time, and
// several operations are unsafe while something else holds it. The binding
// tracked that with four independent flags — `is_busy_`, `IsExecuting()`,
// `call_depth_`, `in_reset_` — and every guarded operation picked a subset **by
// hand**. The correctness of each choice lived only in the author's head at the
// moment of writing, and it was wrong more often than not:
//
//   CR-9   a method with no CallScope left `call_depth_` unarmed        (high)
//   CR-10  the chunk loaders left `IsExecuting()` unarmed               (high)
//   CR-13  `reset()` checked two of the three it needed                 (high)
//   CR-14  the worker OnOKs dropped `is_busy_` before the marshal       (high)
//   CR-15  `execute_script_async` checked one of the three it needed    (high)
//
// Five consecutive high-severity findings, one per pass, all the same shape: an
// operation that takes the state away from its holder, consulting a subset of
// the facts that say whether it has one. Each was fixed at the site and the
// class kept producing sites, because nothing made the *next* operation inherit
// the right set.
//
// **The model.** `Claim` is the set of things that can hold the state.
// `LuaContext::RejectIfOccupied` is the single place that knows which state
// answers each claim, and an operation declares a **policy** naming what
// conflicts with it. Adding a fifth kind of holder means adding one enumerator
// and one `else if` branch in `RejectIfOccupied`; every operation using
// `kExclusive` then inherits it without being edited. That inheritance is the
// whole point: it is what a hand-assembled condition list cannot do.
//
// **There is deliberately no `CurrentClaims()`-style accessor that computes the
// whole set.** The first draft of this model had one, and it was a data race on
// every kSyncApi call site: everything below `AsyncInFlight` reads state a
// worker thread mutates, and testing `AsyncInFlight` first — and *returning* —
// is what makes the rest single-threaded. A new claim must therefore be added
// as a branch in `RejectIfOccupied`'s ordered chain, below that first test, and
// never to an eagerly-computed set. This paragraph replaces an earlier version
// of it that told the reader to add a line to `CurrentClaims()`, a function the
// same commit had already deleted for that exact reason (CR-16 F2).
//
// **The two policies are genuinely different, and neither is "stricter".**
// Synchronous methods deliberately *permit* `LuaExecuting` and `BindingCall`:
// calling `execute_script` from inside a host callback is a supported, tested
// pattern, and so is converting a value from within a type converter. They are
// re-entrant on one thread, which Lua allows. What they cannot tolerate is
// another thread owning the state. `kExclusive` is for operations that take the
// state away from its current holder, where any holder at all is a conflict.
// Choosing between them is a real design decision per operation; the model
// makes it an explicit, named one instead of an implicit one.
namespace lua_occupancy {
enum class Claim : unsigned {
  None = 0,
  // An async run owns the state: a libuv worker (execute_script_async /
  // execute_file_async) or a suspended coroutine-driven run (execute_async).
  AsyncInFlight = 1u << 0,
  // Lua is on this thread's C stack — a host callback, a metamethod, a __gc
  // finalizer, a debug hook. Maintained by the core, which is the only layer
  // that can see every entry into Lua (CR-9's relocation).
  LuaExecuting = 1u << 1,
  // A binding method is mid-flight with user JS running above a conversion that
  // will touch Lua when it returns: a type converter, a definition-object
  // getter, a Proxy trap. Distinct from LuaExecuting — no Lua is running in
  // that window, which is exactly how CR-13 was missed.
  BindingCall = 1u << 2,
  // reset() is between swapping the state and finishing its replay.
  Resetting = 1u << 3,
};

constexpr Claim operator|(const Claim a, const Claim b) {
  return static_cast<Claim>(static_cast<unsigned>(a) | static_cast<unsigned>(b));
}
constexpr Claim operator&(const Claim a, const Claim b) {
  return static_cast<Claim>(static_cast<unsigned>(a) & static_cast<unsigned>(b));
}
constexpr bool Any(const Claim c) { return static_cast<unsigned>(c) != 0; }

// Policy: an ordinary synchronous API method. Re-entrancy on this thread is
// supported; another thread owning the state is not. This is what the
// RejectIfBusy() call sites mean; their count is a frozen invariant
// (`greppable-counts` in tools/invariants.expected.json) rather than a number
// written here, because it was written here as 33 when it was 31.
inline constexpr Claim kSyncApi = Claim::AsyncInFlight;

// Policy: this operation takes the lua_State away from whoever holds it, so any
// holder is a conflict. Used by the two worker-async launchers, which hand the
// state to another thread, and by reset(), which retires it.
//
// Deliberately **not** used by `execute_async`: it is coroutine-driven and stays
// on the main thread, so a nested start re-enters Lua on the thread that already
// owns it — supported, and pinned by a control test. The hazard kExclusive
// addresses is losing exclusive access, not reentrancy as such.
inline constexpr Claim kExclusive =
    Claim::AsyncInFlight | Claim::LuaExecuting | Claim::BindingCall;

// Policy: reset(), which is kExclusive plus its own reentrancy. A reset reached
// from the retiring state's __gc finalizers runs with `runtime` already pointing
// at the replacement, so no other claim can see it (CR-9 F1).
inline constexpr Claim kRetireState = kExclusive | Claim::Resetting;
}  // namespace lua_occupancy

// The two liveness facts a handle needs, carried together so a new handle kind
// cannot pick up one and forget the other.
//
// They are **different questions with the same answer shape**, and collapsing
// them is why every handle used to report "its context has been destroyed"
// after a `reset()` that left the context demonstrably alive (CR-17 F3):
//
//   `handles` is `LuaContext::alive_`, which reset() flips to false and then
//     re-mints. False means "the state this handle indexes was retired" — which
//     happens on reset *and* on destruction.
//   `context`  is `LuaContext::context_alive_`, which is never re-minted. False
//     means the LuaContext object itself is gone.
//
// So `handles == false && context == true` is exactly "reset() replaced my
// state", the case the single flag could not name. `DeadReason()` is the one
// place that turns the pair into words, so the four message sites cannot drift
// apart the way they did.
struct ContextLiveness {
  std::shared_ptr<std::atomic<bool>> handles;
  std::shared_ptr<std::atomic<bool>> context;
  // C2: set once by close(), never cleared. A third flag rather than an
  // inference, because from a handle's side a closed context and a reset one
  // are identical — `handles` is false in both — and the *first* draft of
  // close() therefore told the caller its state "was replaced by reset()".
  // That is another state's story, which is the defect class this tree calls
  // answering with another state's data.
  std::shared_ptr<std::atomic<bool>> closed;

  [[nodiscard]] bool HandlesLive() const { return handles && handles->load(); }
  [[nodiscard]] bool ContextObjectLive() const { return context && context->load(); }
  [[nodiscard]] bool Closed() const { return closed && closed->load(); }
  [[nodiscard]] const char* DeadReason() const {
    if (Closed()) return "its Lua context has been closed";
    return ContextObjectLive()
      ? "its Lua state was replaced by reset(); acquire a new handle"
      : "its Lua context has been destroyed";
  }
};

// A returned Lua-function/table handle keeps its LuaRuntime alive (via the
// shared_ptr) but the LuaContext wrapper is an independent GC root that can be
// collected first. `contextAlive` is a liveness flag shared with the context:
// it flips to false in ~LuaContext, letting a handle used afterwards fail
// cleanly instead of dereferencing a freed `context`.
struct LuaFunctionData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaFunctionRef funcRef;
  LuaContext* context;
  ContextLiveness liveness;

  LuaFunctionData(std::shared_ptr<lua_core::LuaRuntime> rt,
                  lua_core::LuaFunctionRef ref,
                  LuaContext* ctx,
                  ContextLiveness live)
    : runtime(std::move(rt)), funcRef(std::move(ref)), context(ctx),
      liveness(std::move(live)) {}

  ~LuaFunctionData() {
    funcRef.release();
  }

  // True while this handle's Lua state is still the context's current one.
  [[nodiscard]] bool ContextLive() const { return liveness.HandlesLive(); }
};

struct LuaThreadData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaThreadRef threadRef;

  LuaThreadData(std::shared_ptr<lua_core::LuaRuntime> rt, lua_core::LuaThreadRef ref)
    : runtime(std::move(rt)), threadRef(std::move(ref)) {}

  ~LuaThreadData() {
    threadRef.release();
  }
};

// The context half of a bound C function that isn't tied to one Lua reference —
// currently the coroutine `[Symbol.iterator]` factory (A4). Mirrors the
// `context` + `contextAlive` pair the *Data structs carry, so a callback
// invoked after its LuaContext was collected fails cleanly.
struct LuaContextBinding {
  LuaContext* context{};
  ContextLiveness liveness;

  [[nodiscard]] bool ContextLive() const {
    return context && liveness.HandlesLive();
  }
};

struct LuaUserdataData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaUserdataRef userdataRef;

  LuaUserdataData(std::shared_ptr<lua_core::LuaRuntime> rt,
                  lua_core::LuaUserdataRef ref)
    : runtime(std::move(rt)), userdataRef(std::move(ref)) {}

  ~LuaUserdataData() {
    userdataRef.release();
  }
};

struct LuaTableRefData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaTableRef tableRef;
  LuaContext* context;
  ContextLiveness liveness;

  LuaTableRefData(std::shared_ptr<lua_core::LuaRuntime> rt,
                  lua_core::LuaTableRef ref,
                  LuaContext* ctx,
                  ContextLiveness live)
    : runtime(std::move(rt)), tableRef(std::move(ref)), context(ctx),
      liveness(std::move(live)) {}

  ~LuaTableRefData() {
    tableRef.release();
  }

  // True while this handle's Lua state is still the context's current one.
  [[nodiscard]] bool ContextLive() const { return liveness.HandlesLive(); }
};

struct UserdataEntry {
  Napi::ObjectReference object;
  bool readable;
  bool writable;
  // Empty for set_userdata instances; the class name for register_class ones.
  // The property handlers use it to find named accessors (P2b) — which are
  // per-class, while readable/writable are per-instance, so the entry has to
  // carry the link back to its class.
  std::string class_name;
};

// One named property accessor registered by `register_class` (P2b). Either half
// may be absent: a get-only property is read-only and a set-only property is
// write-only, and both refuse the other direction with a message naming the
// class, rather than silently doing nothing.
struct ClassAccessor {
  Napi::FunctionReference getter;
  Napi::FunctionReference setter;
};

// The accessor table for one class, plus its base-class link.
//
// Accessors **do** inherit, unlike `readable`/`writable` and unlike `statics`.
// The rule the three follow is the one `extends` already states: it governs how
// Lua resolves names *on an instance*. A named accessor is instance-name
// resolution — the same question `methods` answers, and ClassIndex already
// chains that — whereas readable/writable are set per instance by the
// constructor and statics live on the class table, which has no lookup chain.
struct ClassAccessorTable {
  std::string parent;  // empty when the class has no base
  std::unordered_map<std::string, ClassAccessor> props;
};

// A JS-side value that several LuaContexts mirror as a global — the backing
// object for `lua_native.createSharedTable()` and the `shared` init option.
//
// Lua states cannot share memory, so "shared" here means *synchronized copies*:
// one JS object is held here and pushed into each subscribed context's global
// namespace with that context's own `set_global`. Propagation is one-way
// (JS -> Lua) and eager — `set()` updates the object and immediately re-pushes
// it everywhere; `sync()` re-pushes after the object was mutated directly.
// Lua-side edits stay local to their context; read them back with that
// context's `get_global`.
class SharedTable final : public Napi::ObjectWrap<SharedTable> {
public:
    // Builds the class. The constructor is not exported — `createSharedTable`
    // is the only way to mint one, and it brands each instance with
    // `lua_tags::kSharedTable`. An object reaching the `shared` option is
    // identified by that brand, **not** by an InstanceOf check against the
    // stored constructor: the constructor is reachable from JS via
    // `createSharedTable().constructor`, so `instanceof` is user-defeatable
    // (CR-15 F5, CR-20 F5). See AsSharedTable.
    static Napi::Function DefineSharedTable(Napi::Env env);

    explicit SharedTable(const Napi::CallbackInfo& info);

    // Non-const despite only reading value_: InstanceMethod's callback type is
    // `Napi::Value (T::*)(const CallbackInfo&)` and node-addon-api declares no
    // const-qualified variant, so `const` here breaks DefineSharedTable.
    //
    // **Expect a clang-tidy `readability-make-member-function-const` on Get's
    // *definition*.** It is correct and unactionable; the definition carries a
    // NOLINT saying so. The finding is reported in the .cpp while the reason
    // lived only here, which is why this keeps getting retried — the note is
    // now at both ends.
    Napi::Value Get(const Napi::CallbackInfo& info);
    Napi::Value Set(const Napi::CallbackInfo& info);
    Napi::Value Sync(const Napi::CallbackInfo& info);

    // Pushes the current value into `context` under `name`, then records the
    // context as a subscriber. Pushing first means a context whose initial push
    // failed is never recorded. Throws Napi::Error if the push fails.
    void Subscribe(const Napi::Object& context, const std::string& name);

    // Pushes the current value into one already-subscribed context without
    // recording it again. Used by LuaContext::Reset to re-establish the shared
    // globals the retired state took with it.
    void PushTo(const Napi::Object& context, const std::string& name) const;

private:
    // The shared object itself, held (not copied) so a caller that mutates the
    // object it passed to createSharedTable can publish the change with sync().
    Napi::ObjectReference value_;

    struct Subscriber {
      // Weak: a SharedTable must not keep a context alive. A collected context
      // reads back empty and is pruned on the next propagation.
      Napi::ObjectReference context;
      std::string name;
    };
    std::vector<Subscriber> subscribers_;

    // Re-pushes the value into every live subscriber and prunes collected ones.
    // Contexts that reject the push (e.g. one busy with an async operation) are
    // collected and reported together, after every other context has been
    // updated — one unavailable context must not silently skip the rest.
    void Propagate(Napi::Env env);

    static void PushValue(const Napi::Object& context, const std::string& name,
                          const Napi::Value& value);
};

// Per-addon-instance data. Keeps the exported class constructors alive for the
// life of the addon instance, and gives the `shared` option a way to recognize
// a genuine SharedTable (whose constructor is deliberately not exported).
struct AddonData {
  Napi::FunctionReference contextConstructor;
  Napi::FunctionReference sharedTableConstructor;
};

class LuaContext final : public Napi::ObjectWrap<LuaContext> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit LuaContext(const Napi::CallbackInfo& info);
    ~LuaContext() override;

    Napi::Value ExecuteScript(const Napi::CallbackInfo& info);
    Napi::Value ExecuteFile(const Napi::CallbackInfo& info);
    Napi::Value ExecuteScriptAsync(const Napi::CallbackInfo& info);
    Napi::Value ExecuteFileAsync(const Napi::CallbackInfo& info);
    Napi::Value ExecuteAsync(const Napi::CallbackInfo& info);
    Napi::Value CallAsync(const Napi::CallbackInfo& info);
    Napi::Value CloseCoroutine(const Napi::CallbackInfo& info);
    Napi::Value ResumeAsync(const Napi::CallbackInfo& info);
    Napi::Value ResumeCoroutineObjectAsync(const Napi::Object& coroObj,
                                           const std::vector<Napi::Value>& args_js,
                                           const Napi::Object& self);
    // Shared `{ status, values, error? }` marshalling for resume/resume_async.
    Napi::Value CoroutineResultToJs(const Napi::Object& coroObj,
                                    lua_core::CoroutineStatus status,
                                    const std::vector<lua_core::LuaPtr>& values,
                                    const std::optional<std::string>& error);
    Napi::Value Cancel(const Napi::CallbackInfo& info);
    Napi::Value IsBusyMethod(const Napi::CallbackInfo& info);
    Napi::Value SetGlobal(const Napi::CallbackInfo& info);
    Napi::Value GetGlobal(const Napi::CallbackInfo& info);
    Napi::Value Call(const Napi::CallbackInfo& info);
    Napi::Value SetUserdata(const Napi::CallbackInfo& info);
    Napi::Value SetMetatable(const Napi::CallbackInfo& info);
    Napi::Value CreateCoroutine(const Napi::CallbackInfo& info);
    Napi::Value ResumeCoroutine(const Napi::CallbackInfo& info);
    Napi::Value AddSearchPath(const Napi::CallbackInfo& info);
    Napi::Value RegisterModule(const Napi::CallbackInfo& info);
    Napi::Value Compile(const Napi::CallbackInfo& info);
    Napi::Value CompileFile(const Napi::CallbackInfo& info);
    Napi::Value LoadBytecode(const Napi::CallbackInfo& info);
    Napi::Value CreateTableMethod(const Napi::CallbackInfo& info);
    Napi::Value GetGlobalRef(const Napi::CallbackInfo& info);
    Napi::Value CreateEnvironment(const Napi::CallbackInfo& info);
    Napi::Value ExecuteScriptIn(const Napi::CallbackInfo& info);
    Napi::Value GetMemoryUsage(const Napi::CallbackInfo& info);
    Napi::Value Info(const Napi::CallbackInfo& info);
    // Per-container counts of the JS values this context's bookkeeping holds
    // alive, returned as `info().bindingRefs`. Diagnostic only; see the
    // definition for why it ships rather than living behind a debug build, and
    // `tools/binding-balance/policy.mjs` for what each count is allowed to do.
    Napi::Object BindingRefCounts();
    Napi::Value RegisterTypeConverter(const Napi::CallbackInfo& info);
    Napi::Value RegisterFromLuaConverter(const Napi::CallbackInfo& info);
    Napi::Value RegisterClass(const Napi::CallbackInfo& info);
    Napi::Value Pcall(const Napi::CallbackInfo& info);
    Napi::Value SetPrintHandler(const Napi::CallbackInfo& info);
    Napi::Value AddSearcher(const Napi::CallbackInfo& info);
    Napi::Value SetReadHandler(const Napi::CallbackInfo& info);
    Napi::Value SetFileReader(const Napi::CallbackInfo& info);
    Napi::Value SetHook(const Napi::CallbackInfo& info);
    Napi::Value RemoveHook(const Napi::CallbackInfo& info);
    // R1: read-only debug introspection (get_stack / get_locals).
    Napi::Value GetStack(const Napi::CallbackInfo& info);
    Napi::Value GetLocals(const Napi::CallbackInfo& info);
    Napi::Value Release(const Napi::CallbackInfo& info);
    // C2: end the context now (CONTEXT-TEARDOWN-PLAN).
    Napi::Value Dispose(const Napi::CallbackInfo& info);
    Napi::Value Reset(const Napi::CallbackInfo& info);
    Napi::Value GC(const Napi::CallbackInfo& info);

    void ClearBusy();

    // True while any async op (worker-thread or coroutine-driven) is in flight.
    // Lua-side entry points (the function trampoline, table traps) consult this
    // to reject reentry into the shared state during a suspension. Public so
    // those free functions can reach it.
    bool IsBusy() const { return is_busy_.load(); }

    // Public so LuaFunctionCallbackStatic can use it
    Napi::Value CoreToNapi(const lua_core::LuaValue& value);
    lua_core::LuaValue NapiToCoreInstance(const Napi::Value& value, int depth = 0);

    // Marshals a Lua result list to a JS value: undefined for none, the value
    // itself for one, an array for many. Public so the async workers and the
    // Lua-function trampoline can share it.
    Napi::Value ResultsToJs(const std::vector<lua_core::LuaPtr>& values);

    // Resumes `coro` with `args` and returns the CoroutineResult object
    // ({ status, values, error? }), or throws a JS exception and returns
    // undefined. The body of resume(), factored out so the iterator protocol
    // (A4) drives a coroutine through exactly the same path. The caller is
    // responsible for the busy guard and the outermost CallScope. Public so the
    // iterator's free-function `next` can reach it.
    Napi::Value ResumeCoroutineObject(const Napi::Object& coro,
                                      const std::vector<Napi::Value>& args);

    // Wraps a registry table reference as a `LuaTableHandle` JS object. Public
    // so the handle's own `get_ref` free function can mint the nested handle it
    // returns.
    Napi::Object CreateTableHandle(Napi::Env env_, int registry_ref);

    // Wraps `data` (whose ownership passes to the returned object's finalizer)
    // as the JS coroutine object: the `_coroutine` marker, a `status` string,
    // and the `Symbol.iterator` factory that makes it usable with for..of /
    // for await (A4). Takes a unique_ptr so the thread's registry ref is
    // released rather than orphaned if an N-API allocation throws before the
    // finalizer becomes its owner (CR-9 F4).
    Napi::Object CreateCoroutineObject(std::unique_ptr<LuaThreadData> data,
                                       const std::string& status);

    // Reconstructs the original JS error for a surfaced Lua error (or a plain
    // Error from the string) and throws it. Public so LuaFunctionCallbackStatic
    // can use it.
    Napi::Value LuaErrorToJsValue(const std::string& fallback);
    void ThrowLuaError(const std::string& fallback);

    // RAII: raises `call_depth_`, and clears the JS-error registry at the
    // outermost entry.
    //
    // The invariant this maintains is **"a binding method is on the stack, so
    // JS may re-enter this context"** — deliberately *not* "Lua may be
    // running", which is the core's `IsExecuting()` and a different fact.
    // `reset()` needs both: it retires the lua_State, and a method caught
    // mid-flight resumes holding refs minted by a state that no longer exists.
    //
    // **Open one as the first statement of the method.** A binding method does
    // not start at its call into Lua — it starts by running user JS: type
    // converters, definition-object getters, Proxy traps on a caller-supplied
    // object. CR-13 F1 found this scope placed around the Lua call at seven
    // entry points and absent from an eighth, leaving that whole
    // argument-conversion / definition-reading phase unguarded; a converter
    // calling `reset()` from inside `handle.pairs()` produced handles pairing
    // the new runtime with the old state's registry refs — silent cross-object
    // reads and writes, and an ASan-confirmed use-after-free of the retired
    // state at finalization.
    //
    // The invariant is checkable, and the check is mechanical — but a
    // mechanical check has two halves, the predicate and the **universe it
    // ranges over**, and only the first is usually written down. CR-13 wrote
    // the predicate and left the universe implied; read as "LuaContext instance
    // method" it returned clean on a tree containing an ASan-confirmed
    // use-after-free in a worker completion callback (CR-14 F1). So the
    // universe is stated first, and it is the hazard's:
    //
    //   **Every function in lua-native.cpp that, on the main thread, reads
    //   `runtime` / `alive_` / `js_userdata_` (or mints a handle from them) and
    //   can also run user JS.** That is: the instance methods, the Proxy traps
    //   and table-handle methods, the coroutine-iterator callbacks, the
    //   SharedTable methods — and the N-API completion callbacks, which are not
    //   methods and take no CallbackInfo. Helper functions count as their
    //   caller's: `LuaFunctionDataFrom` and `TableRefDataFrom` both run
    //   `Has`/`Get` on a caller-supplied object, so a per-function split of this
    //   file does not see them at their call sites.
    //
    // Predicate: within that universe, this scope should appear above the first
    // `.Get(` / `.Call(` / `GetPropertyNames(` / `NapiToCoreInstance(` /
    // `CoreToNapi(` / `LuaFunctionDataFrom(` / `TableRefDataFrom(` line.
    //
    // Two members are guarded by `is_busy_` instead of by a scope, which is a
    // different mechanism and so is easy to mis-read as an omission:
    // `DriveAsync` (its Finished branch marshals *before* FinishAsync) and
    // `OnAwaitSettled` (converts while the run is still engaged). See
    // ClearBusy(), which records the ordering rule all three marshalling sites
    // depend on.
    //
    // Members that run user JS with a *later* scope — each verified inert, so
    // an addition is a regression:
    //
    //   TableRefGetTrap      — `target.Get("_tableRef")` is a fast-path return
    //                          on the addon's own proxy target; it touches no
    //                          runtime state and falls out before the Lua work.
    //   CoroIteratorNext     — `coro.Get("_coroutine")` is a dead-status probe;
    //                          `this` is user-supplied (`iter.call(proxy)`), so
    //                          it can be a trap, but ResumeCoroutineObject
    //                          re-reads the marker inside the scope and rejects
    //                          on runtime identity. The scope is above the
    //                          resume and the argument conversion.
    //   CreateCoroutine      — `LuaFunctionDataFrom(info[0])` runs `Has`/`Get`
    //                          (a Proxy over a Lua function is `IsFunction()`),
    //                          and the runtime-identity / released-ref checks
    //                          run after them. Fails closed.
    //   ExecuteScriptIn      — `TableRefDataFrom(info[0])`, same shape; only a
    //                          `Utf8Value()` separates its identity check from
    //                          the use.
    //
    // Members that run user JS with *no scope at all*. CR-13 and CR-14 both
    // filed these under the heading above; they have no scope to be above, and
    // the distinction matters because "find the first CallScope" returns
    // nothing for them rather than returning a line to compare (CR-15 F4):
    //
    //   SharedTable::Get     — a plain read of the shared JS object. No runtime.
    //   SharedTable::Set     — push to every subscriber. The *reason* CR-13 gave
    //   SharedTable::Sync      ("each push routes through that context's own
    //   SharedTable::PushValue set_global, which opens its own scope") is not
    //   ::PushTo ::Subscribe   quite true: PushValue reads `context.Get(
    //   ::Propagate            "set_global")`, and an own property on the
    //                          wrapper shadows the prototype method, so the push
    //                          can be an arbitrary user function. It is still
    //                          inert — SharedTable holds no runtime, no alive_
    //                          and no js_userdata_, so there is nothing here for
    //                          a reset to invalidate — but the inertness comes
    //                          from what SharedTable *is*, not from where the
    //                          value goes.
    //   LuaContext (ctor)    — reads its options object before `runtime` exists;
    //                          there is no state to retire, by construction.
    //   Pcall                — runs the caller's function, then only packages
    //                          the result. Nothing to invalidate.
    //   Release              — its `Has`/`Get` can run traps, but the
    //                          `data->runtime.get() != runtime.get()` check runs
    //                          *after* them and fails closed on a foreign handle.
    //   RegisterCallbacks    — inert from the constructor (no state yet); from
    //                          reset() it is inside reset()'s own scope, which
    //                          is why that scope exists (CR-15 F1c).
    //   CreateTableHandle    — `DefineHiddenProp` reads a patchable
    //   CreateCoroutineObject  `Object.defineProperty` off the global, and
    //   CoroSymbolIterator     CoroSymbolIterator also reads `Symbol.iterator`.
    //                          Inert only because each builds its *Data and
    //                          pairs it with the runtime *before* the first
    //                          patchable call, so a reset from a trap flips
    //                          alive_ and the handle fails closed. Reordering
    //                          any of the three re-opens CR-13 F1.
    //
    // Helper functions whose user JS counts as their caller's: `LuaFunctionDataFrom`
    // and `TableRefDataFrom` (Has/Get on a caller-supplied object), plus
    // `DefineHiddenProp` and `SymbolIteratorKey`, which read `Object` /
    // `Symbol` off the global and are called from eight sites between them —
    // `TableRefToMap` and `MapToTableRef` (T1) join them: both read and write
    // JS objects (a Map's entries, the Map constructor off the global) and both
    // are reached only through `CoreToNapi` / `NapiToCore`, whose entry points
    // already hold a scope for exactly that reason.
    // And, since August 7, 2026, `ParseChunkName`, whose `Get("chunkName")` on
    // a caller-supplied options object can be an accessor. Its five callers all
    // hold a scope across the call, and `execute_script_async` grew one for
    // exactly this reason: it had none, because until then it read nothing off
    // a caller's object. That scope is also why the read happens *before*
    // `is_busy_` is set — a throwing getter must leave the context idle rather
    // than busy with no worker queued to clear it.
    //
    // Members that deliberately have no scope and run no user JS at all:
    // `remove_hook`, `get_memory_usage`, `info`, `register_type_converter`,
    // `register_from_lua_converter` (each reads `info` and stores), plus the
    // three that must work regardless — `reset()`, `cancel()` (must work while
    // a run is in flight) and `is_busy()` (reads one atomic).
    //
    // `execute_script_async` / `execute_file_async` were on that last list until
    // CR-15. They still run no user JS — but the list's premise is "touches no
    // state a reset can invalidate", and they are not readers at all: they hand
    // the lua_State to another thread. They declare
    // `lua_occupancy::kExclusive`; see the Claim comment at the top of this file.
    //
    // `reset()` is on it too, as "it *is* the guarded operation". That is true
    // of its guard block and false of everything after the state swap, where it
    // becomes a holder running user JS. It now opens a scope there (CR-15 F1c).
    //
    // Both lists above are hand-maintained, which is their weakness: CR-14
    // found ten omissions and every one was inert; CR-15 found nine more and a
    // wrong heading. An omission with a consequence gets caught by a test, so
    // only the harmless ones survive in a list like this — which is what makes
    // it look healthy right up until a non-inert member joins.
    //
    // The membership question is therefore no longer answered here. The
    // predicate stated above is computed over this whole file by
    // `callScopeClassification()` in `tools/invariants.mjs`, and the answer is
    // frozen in `tools/invariants.expected.json`, so a function that changes
    // class — or a new one that arrives with no scope — turns
    // `tests/ts/invariants.spec.ts` red instead of quietly joining a list.
    //
    // Read the prose above for *why* each current member is inert; read
    // `node tools/check-invariants.mjs` for *who the members are*. When those
    // two disagree, the generated one is right — that is the whole point, and
    // it is what three passes of repairing this enumeration by hand bought.
    struct CallScope {
      LuaContext* ctx;
      explicit CallScope(LuaContext* c) : ctx(c) {
        if (ctx->call_depth_++ == 0) ctx->js_error_registry_.clear();
      }
      ~CallScope() { --ctx->call_depth_; }
    };

    // RAII: collects the reclaimable __js_callback_ names minted while a
    // JS→Lua conversion is in flight, so values that are discarded before ever
    // being pushed sweep the entries they registered (N4/F1).
    //
    // The destructor sweeps whatever is left in `names`, which makes every exit
    // path — early return, thrown exception, or a core call failing after the
    // conversions succeeded — self-cleaning. Sweeping is unconditionally safe
    // even on the success path: a name whose closure was materialized has a live
    // count >= 1 (or its entry is already gone), and SweepUnpushedJsCallbacks
    // only erases entries still at 0. Success paths that hand ownership upward
    // call PropagateToParent(), which empties `names` so the sweep is a no-op.
    //
    // Scopes nest (a type converter can re-enter conversion from user JS, and a
    // method-level scope encloses the per-conversion ones); each restores its
    // parent on destruction.
    struct JsCallbackCollectorScope {
      LuaContext* ctx;
      std::vector<std::string>* prev;
      std::vector<std::string> names;
      explicit JsCallbackCollectorScope(LuaContext* c)
          : ctx(c), prev(c->js_callback_collector_) {
        ctx->js_callback_collector_ = &names;
      }
      ~JsCallbackCollectorScope() {
        ctx->js_callback_collector_ = prev;
        // A destructor must not throw; the sweep only erases map entries, but
        // contain anything unexpected rather than risking std::terminate.
        try {
          if (!names.empty()) ctx->SweepUnpushedJsCallbacks(names);
        } catch (...) {}
      }
      // Hands the collected names to the enclosing scope (if any) when this
      // conversion succeeds but an outer scope may still discard the value.
      void PropagateToParent() {
        if (prev) prev->insert(prev->end(), names.begin(), names.end());
        names.clear();
      }
    };

    // Drops the entries for any of `names` whose Lua closure was never
    // materialized (live count 0), both runtime-side and the paired
    // js_callbacks_ reference (N4). Public so JsCallbackCollectorScope and the
    // static Lua-function trampoline can reach it.
    void SweepUnpushedJsCallbacks(const std::vector<std::string>& names);

    // Reserves each deferred function-entry name as reclaimable before the core
    // call that materializes its closure, and records it with the active
    // collector so a failed core call sweeps the reservation (CR-11 F4). Public
    // only because it sits beside SweepUnpushedJsCallbacks, which is.
    void ReserveDeferredCallbacks(
        const std::vector<std::pair<std::string, Napi::Function>>& deferred) const;

private:
    // The addon env, captured at construction. Safe to reuse from later instance
    // methods because they all run on the same JS thread while this ObjectWrap is
    // alive. It must NOT be used from a worker thread (see the async workers,
    // which take their env from the AsyncWorker instead).
    Napi::Env env;
    std::shared_ptr<lua_core::LuaRuntime> runtime;
    std::unordered_map<std::string, Napi::FunctionReference> js_callbacks_;
    // The per-crossing wrapper data (LuaFunctionData / LuaThreadData /
    // LuaUserdataData / LuaTableRefData) is not held here: each is owned by an
    // N-API finalizer tied to the JS object it backs, so it (and its registry
    // ref) is freed when that object is garbage-collected. Each *Data keeps its
    // own shared_ptr<LuaRuntime>, so the Lua state outlives every wrapper.

    // Set on the main thread around any in-flight async op (worker-thread
    // execute_*_async and coroutine-driven execute_async). Atomic for defensive
    // safety even though it is only touched on the main thread.
    std::atomic<bool> is_busy_{false};

    // Flipped to false in ~LuaContext. Shared (by shared_ptr) with every
    // returned function/table handle so a handle used after the context is
    // destroyed fails cleanly instead of dereferencing freed memory.
    //
    // Also re-minted by reset(), which is what makes it the wrong flag for the
    // host-function wrappers — see context_alive_ below.
    std::shared_ptr<std::atomic<bool>> alive_ =
        std::make_shared<std::atomic<bool>>(true);

    // Flipped to false in ~LuaContext and never re-minted. Captured by the
    // host-function wrappers (CreateJsCallbackWrapper /
    // CreateConstructorWrapper), which are stored on the runtime and can be
    // invoked long after this context dies: every outstanding handle keeps the
    // runtime alive, so lua_close — and the __gc metamethods it fires — may run
    // at an arbitrary later GC, dispatching into a wrapper whose captured
    // `this` is freed memory (CR-10 F2).
    //
    // Deliberately distinct from alive_. alive_ answers "are handles from this
    // generation still valid", so reset() sets it false and mints a new one;
    // the wrappers need the different fact "is the LuaContext object itself
    // alive", which a reset does not change — the retiring state's own __gc
    // finalizers must still be able to reach the (live) context.
    std::shared_ptr<std::atomic<bool>> context_alive_ =
        std::make_shared<std::atomic<bool>>(true);

    // In-flight coroutine-driven async execution state (execute_async,
    // call_async, resume_async). Only one runs at a time (guarded by is_busy_).
    //
    // The driven thread comes in two flavours and the difference is ownership,
    // not mechanism:
    //
    //  * **Binding-owned** (execute_async, call_async): the thread was created
    //    for this run and nothing else refers to it. `async_co_` holds the ref
    //    and FinishAsync releases it.
    //  * **Caller-owned** (resume_async, P1b): the thread belongs to a
    //    coroutine object the caller still holds and may resume again later.
    //    `async_co_` stays disengaged, `async_borrowed_` points at the caller's
    //    LuaThreadData, and FinishAsync releases *nothing* — abandoning the run
    //    must leave the coroutine suspended and resumable, matching what an
    //    early `break` out of `for..of` already leaves behind.
    //
    // `async_borrowed_` points into an object owned by an External finalizer, so
    // the run roots that object in `async_coro_obj_` for its whole duration —
    // otherwise a suspended await could outlive the coroutine object and resume
    // through freed memory.
    std::optional<lua_core::LuaThreadRef> async_co_;
    LuaThreadData* async_borrowed_ = nullptr;
    Napi::ObjectReference async_coro_obj_;
    // True when the run was started by resume_async. It changes exactly one
    // decision — what a plain `coroutine.yield` means. For execute_async and
    // call_async there is no resumer for it and it is an error; for resume_async
    // it is an ordinary suspension that settles the promise with the yielded
    // values, which is the whole point of the door.
    bool async_coroutine_mode_ = false;
    // The thread this run drives, whichever flavour it is. Valid only while a
    // run is engaged (AsyncDriverEngaged()).
    [[nodiscard]] const lua_core::LuaThreadRef& AsyncDrivenThread() const;
    // True while a main-thread coroutine-driven run is in flight. Distinct from
    // is_busy_, which is also true for the worker-thread doors.
    [[nodiscard]] bool AsyncDriverEngaged() const {
      return (async_co_.has_value() || async_borrowed_ != nullptr) &&
             async_deferred_.has_value();
    }
    std::optional<Napi::Promise::Deferred> async_deferred_;
    Napi::ObjectReference async_pending_promise_;
    // Roots the wrapping JS object for the lifetime of an execute_async run so
    // the ObjectWrap can't be garbage-collected while the coroutine is suspended
    // awaiting a promise (the settlement callbacks hold only a raw pointer).
    Napi::ObjectReference async_self_ref_;
    // True only while a resume is executing on the C stack (inside DriveAsync).
    // cancel() called re-entrantly from a host callback during that window must
    // defer teardown — see Cancel()/DriveAsync().
    bool async_resuming_ = false;
    // Bumped when each execute_async run starts. The await-settlement callbacks
    // capture the generation they were created for; a settlement whose generation
    // no longer matches (e.g. a promise from a cancelled run) is ignored so it
    // can't drive a later run's coroutine.
    uint64_t async_generation_ = 0;

    // Arms the await driver and takes the first step. Every main-thread async
    // door goes through it so they cannot drift apart in what they arm — the
    // divergence P1 was reported for. The caller must have set exactly one of
    // `async_co_` (owned) or `async_borrowed_` + `async_coro_obj_` (borrowed)
    // beforehand.
    // `arg_role` names `args` in a conversion-failure message and is forwarded
    // to LuaRuntime::ResumeAsyncStep, whose header carries the reasoning: this
    // is the opening step, so for call_async these are the caller's *arguments*
    // rather than resume values (CR-23 F5).
    // `args` is borrowed, not owned, and that is safe for a specific reason
    // rather than by luck: DriveAsync forwards it to a single ResumeAsyncStep
    // call that happens *before* any user JS or Lua runs, and never touches it
    // afterwards. Nothing a re-entrant callback could reach owns the caller's
    // vector either — it is a local in the calling door's frame. Taking it by
    // value would move-construct at every call site (all three move or pass
    // `{}`), which costs a vector move for a parameter this function only reads.
    Napi::Value BeginAsyncRun(const Napi::Object& self,
                              const std::vector<lua_core::LuaPtr>& args,
                              const char* arg_role = "resume value");
    void DriveAsync(const std::vector<lua_core::LuaPtr>& args, bool is_error,
                    const char* arg_role = "resume value");
    Napi::Value OnAwaitSettled(const Napi::Value& value, bool is_error, uint64_t gen);
    void FinishAsync();

    // --- The async-run liveness guard (the H2 re-check) -----------------------
    //
    // True if the execute_async run identified by `gen` is no longer the one
    // this context is driving: it was settled, or it was settled *and replaced*
    // by a newer run. The single place that answers that question, for the same
    // reason lua_occupancy::Claim is the single place that answers "who holds
    // the state" — four hand-written copies of this predicate is how CR-16 F1
    // happened, with three sites having it and the fourth not.
    //
    // **Every site that runs user JS between deciding to settle a run and
    // actually settling it must call this afterwards.** `cancel()` is the
    // reason: it is deliberately exempt from the occupancy guard (it must work
    // while `is_busy_` is true — that is its entire job), so it is the one
    // operation a marshal cannot refuse. It calls FinishAsync() and settles the
    // deferred; a caller that then settles its own copy of that deferred
    // concludes an already-concluded napi_deferred, which N-API has freed.
    // Driven as a deterministic SIGSEGV in ConcludeDeferred (CR-16 F1).
    //
    // `async_generation_` covers the harder half: a converter may cancel() and
    // then start a *new* run, re-engaging async_deferred_ with a different
    // promise. Testing the optional alone would pass and tear the new run down.
    [[nodiscard]] bool AsyncRunSuperseded(uint64_t gen) const {
      // Asks whether *a run is still engaged*, which is why it goes through
      // AsyncDriverEngaged rather than testing async_co_: a resume_async run
      // drives a borrowed thread and leaves async_co_ disengaged the whole time,
      // so the direct test reported every such run as already superseded and no
      // settle site ever fired.
      return !AsyncDriverEngaged() || gen != async_generation_;
    }
    static Napi::Value OnAwaitResolveStatic(const Napi::CallbackInfo& info);
    static Napi::Value OnAwaitRejectStatic(const Napi::CallbackInfo& info);

    // User-registered JS->Lua type converters, consulted (in registration
    // order) before built-in type handling. Each entry is a {match, convert}
    // pair of JS functions.
    std::vector<std::pair<Napi::FunctionReference, Napi::FunctionReference>> type_converters_;

    // The other direction (B3): Lua->JS converters, consulted (in registration
    // order) on the *result* of the built-in conversion, so a Lua table that
    // encodes an application type can be rebuilt as that type on the way out.
    // Only object-valued results are offered, mirroring how the JS->Lua
    // converters above skip primitives.
    std::vector<std::pair<Napi::FunctionReference, Napi::FunctionReference>> from_lua_converters_;

    // The liveness pair every handle this context mints must carry. One place
    // that assembles it, so the two flags cannot be paired up wrongly at a new
    // mint site (see ContextLiveness for why there are two).
    [[nodiscard]] ContextLiveness Liveness() const { return {alive_, context_alive_, closed_flag_}; }

    // Returns `ref` unchanged if it belongs to this context's current runtime,
    // and an already-released copy of it otherwise. Every registry-backed
    // handle minted below must pass its ref through this, because pairing a ref
    // with a runtime that does not own it is a use-after-free at teardown and a
    // cross-state registry aliasing bug while it lives (CR-17 F1). The one
    // caller that produces foreign refs is `reset()`, whose swap makes the
    // retiring state's `__gc` finalizers dispatch against the replacement.
    // See the definition for why a valid pairing is impossible rather than
    // merely missing.
    template <typename RefT>
    RefT RefForThisRuntime(const RefT& ref) const;

    // The built-in half of CoreToNapi. CoreToNapi is this plus the from-Lua
    // converter pass, and it is what every recursive call goes through, so a
    // converter reaches values nested inside tables and arrays too.
    Napi::Value CoreToNapiBuiltin(const lua_core::LuaValue& value);
    // `tableAs: 'map'` (T1): render a plain Lua table as a JS Map with its real
    // keys. Recursive; `depth` is bounded by kMaxTableDepth for the reason the
    // definition states.
    Napi::Value TableRefToMap(const lua_core::LuaTableRef& ref, int depth);
    // Inbound mirror of the above: a JS Map -> a real Lua table, by reference.
    lua_core::LuaValue MapToTableRef(const Napi::Object& map, int depth);
    static constexpr int kMaxTableDepth = 100;  // matches the core's kMaxDepth

    // Userdata reference tracking. next_userdata_id_ keys the int-based userdata
    // maps and the in-userdata-block storage, so it stays int; the remaining
    // counters only feed unique-name strings and are widened to avoid overflow.
    //
    // "Stays int" is a real constraint — the id is stored *inside the Lua
    // userdata block* as an int, so widening it is a core-and-binding change,
    // not a one-line one — but it is not a licence to overflow: signed overflow
    // is UB, and a process calling set_userdata per request reaches 2^31. The
    // counter is therefore range-checked at its single increment site rather
    // than widened, which converts a UB wrap into a clean JS error (CR-13 F3).
    std::unordered_map<int, UserdataEntry> js_userdata_;
    // The `__ud_method_<ref_id>_<name>` host functions minted for each userdata,
    // so they can be dropped when that userdata is collected.
    //
    // Their closures are built lazily by the core's UserdataIndex (from names
    // held in the `_ud_methods_<ref_id>` registry table), so the reclaim-sentinel
    // mechanism cannot see them — but their natural lifetime is the userdata's,
    // and the runtime already tells us when that ends. Without this, every
    // set_userdata(..., { methods }) pinned its method closures for the life of
    // the context even after the userdata was gone (CR-11 F4).
    std::unordered_map<int, std::vector<std::string>> ud_method_fns_;
    int next_userdata_id_ = 1;
    uint64_t next_metatable_id_ = 1;
    uint64_t next_module_id_ = 1;
    uint64_t next_class_id_ = 1;
    uint64_t next_searcher_id_ = 1;
    uint64_t next_js_callback_id_ = 1;  // monotonic id for anonymous nested callbacks

    // Output redirection (E1): JS handler for print()/io.write().
    Napi::FunctionReference print_handler_;
    void InstallPrintHandler(const Napi::Function& fn);

    // Input redirection (P4a): JS handler for io.read(). The counterpart E1
    // never had — output has been redirectable since July 2026 while input
    // still reached the process's real stdin.
    Napi::FunctionReference read_handler_;
    // False when the core refused to wire io.read (a non-table global `io`); the
    // handler is then not retained. See LuaRuntime::SetInputHandler.
    bool InstallReadHandler(const Napi::Function& fn);

    // Virtual file access (P4b): JS reader backing dofile()/loadfile().
    Napi::FunctionReference file_reader_;
    void InstallFileReader(const Napi::Function& fn);

    // Debug hook (lua_sethook) state. The mask and interval are kept alongside
    // the JS callback so reset() can re-arm the hook on the replacement state,
    // the same way the print handler is replayed.
    Napi::FunctionReference debug_hook_;
    int debug_hook_mask_ = 0;
    int debug_hook_count_ = 0;
    void InstallDebugHook(const Napi::Function& fn, int mask, int count);

    // Error fidelity (D1): keeps thrown JS Error objects alive so they can be
    // reconstructed when a Lua error carrying their id surfaces back to JS.
    //
    // Widened with the other monotonic counters (CR-12 F5): unlike
    // next_userdata_id_, nothing here constrains the key to int, and a
    // long-lived server with a throwing callback per request is exactly the
    // shape that reaches 2^31 — where signed overflow is UB rather than a
    // harmless wrap. The id travels through Lua as an int64_t field, so the
    // round trip stays exact.
    std::unordered_map<uint64_t, Napi::ObjectReference> js_error_registry_;
    uint64_t next_js_error_id_ = 1;
    int call_depth_ = 0;  // clears the registry when the outermost call starts

    // True for the duration of Reset(). Guards the one reentrancy window the
    // core's LuaRuntime::IsExecuting() cannot see: the outgoing state's
    // lua_close fires __gc finalizers after `runtime` already points at the
    // replacement, so a finalizer that calls reset() would see a fresh runtime
    // reporting depth 0 (CR-9 F1).
    bool in_reset_ = false;

    // Names of classes already registered on this context. luaL_newmetatable
    // silently returns the existing metatable for a repeated name, so a second
    // register_class(sameName) would half-merge definitions; reject it (L7).
    std::unordered_set<std::string> registered_classes_;

    // Named property accessors per class (P2b), keyed by class name. Held here
    // rather than pushed into Lua because the accessor has to *run JS* on every
    // read/write — there is nothing to put in a Lua table but a host-function
    // name, and routing through one would mean a Lua closure call plus a
    // registry lookup per property access, to reach the same JS function this
    // map holds directly. Consulted by the property handlers installed in
    // InstallRuntimeHandlers.
    //
    // A class registration cannot be superseded (registered_classes_ forbids
    // reusing a name), so entries here are permanent by design — the same
    // reasoning that leaves a class's constructor and methods unreclaimable.
    std::unordered_map<std::string, ClassAccessorTable> class_accessors_;

    // Resolve `key` to an accessor, walking the base chain. Returns nullptr when
    // no class in the chain declares it. Depth-capped for the same reason the
    // core's ClassIndex walk is: the chain is acyclic by construction, so the
    // cap only bounds a map someone corrupted.
    [[nodiscard]] const ClassAccessor* FindClassAccessor(
        const std::string& class_name, const std::string& key) const;

    // Stages a structured error table for a thrown JS value (object errors only)
    // and returns the display message.
    //
    // `owner` is the runtime whose bridge is about to raise, and it is NOT
    // always this context's current runtime: reset() deliberately lets the
    // retiring state's __gc finalizers reach the still-live context (CR-10's
    // documented contract), so a callback that throws from one of those raises
    // on the *old* state while `runtime` already points at the new one. Staging
    // there would leave the new runtime holding a pending value from an
    // execution on a different Lua state — the M12 hazard reached through
    // generations (CR-12 F4) — so a mismatch falls back to the plain message,
    // which is exactly what the raising state's bridge would have used anyway.
    // nullptr means "the current runtime by construction": the async
    // promise-settlement path stages from a microtask with no execution in
    // flight at all, and it consumes the staged value itself.
    std::string StageJsError(const Napi::Value& value, const std::string& message,
                             const lua_core::LuaRuntime* owner = nullptr);

    // Mints the next userdata ref_id. The single increment site for
    // next_userdata_id_, so the "must stay int" constraint documented there
    // cannot silently become a signed-overflow UB: this throws instead of
    // wrapping (CR-13 F3). Callers are on paths that already convert a
    // std::exception into a JS error.
    int NextUserdataId();

    // --- The occupancy guard --------------------------------------------------
    //
    // The single place that maps a claim to the state answering it, and the
    // single place that reports a conflict. Every guarded operation names a
    // **policy** from lua_occupancy rather than assembling conditions itself;
    // see the comment on `lua_occupancy::Claim` for why.
    //
    // Returns true (having thrown) if any claim in `disallowed` is held. `op`
    // names the operation for the message and may be null for kSyncApi, whose
    // message predates the scheme and is pinned by a great many tests.
    // `detail` is an optional trailing clause explaining why this operation
    // cares.
    //
    // There is deliberately **no** "compute the whole claim set" accessor: the
    // claims must be evaluated lazily in the order the definition uses, because
    // everything below `AsyncInFlight` reads state a worker thread mutates. The
    // first draft of this refactor had one, and it was a data race on every
    // kSyncApi call site. See the definition.
    bool RejectIfOccupied(const char* op, lua_occupancy::Claim disallowed,
                          const char* detail = nullptr) const;

    // The kSyncApi policy, kept under its original name because every
    // synchronous API method and a great many tests use it —
    // `grep -c 'if (RejectIfBusy())' src/lua-native.cpp` is the count, so nobody
    // has to keep a number here correct (it was written as 33 and was 31). That
    // grep is now also a frozen invariant, so the count moving is a red test
    // rather than something a reader has to re-run. Equivalent to
    // `RejectIfOccupied(nullptr, lua_occupancy::kSyncApi)`.
    bool RejectIfBusy() const;

    // Recursive body of NapiToCoreInstance; the public entry wraps depth 0 in
    // a JsCallbackCollectorScope so an aborted conversion sweeps the
    // reclaimable callback entries it minted (N4).
    lua_core::LuaValue NapiToCoreImpl(const Napi::Value& value, int depth);
    // Active collector for in-flight conversions (nullptr when none). See
    // JsCallbackCollectorScope.
    std::vector<std::string>* js_callback_collector_ = nullptr;

    // The chain of objects currently being converted, innermost last, used to
    // tell a *cycle* from mere depth (CR-20 F2). Before the fix a cyclic object
    // was reported as "Value nesting depth exceeds the maximum of 100 levels" —
    // a two-key object described as a hundred levels deep, with the implied
    // remedy (flatten it) one no amount of flattening achieves.
    //
    // **Path, not visited-set.** Entries are popped on the way back out, so an
    // object referenced twice as siblings — a DAG, which is legal and common —
    // is converted twice rather than reported as a cycle. Only an object that
    // is its own ancestor is one.
    //
    // Compared with StrictEquals rather than by napi_value identity: a handle
    // is not a stable identity for a JS object, and the path is bounded by
    // kMaxDepth so the linear scan is bounded too.
    std::vector<Napi::Value> conversion_path_;

    // RAII for the above, and for the reset a re-entrant conversion needs: a
    // type converter can call back in with a *different* value tree, and a
    // value legitimately present in both trees must not read as a cycle. The
    // top-level entry therefore hides the enclosing path rather than extending
    // it.
    struct ConversionPathScope {
      LuaContext* ctx;
      std::vector<Napi::Value> saved;
      explicit ConversionPathScope(LuaContext* c) : ctx(c) {
        saved.swap(ctx->conversion_path_);
      }
      ~ConversionPathScope() { ctx->conversion_path_.swap(saved); }
    };

    // Pushes `v` for the duration of one nested conversion.
    struct ConversionPathEntry {
      LuaContext* ctx;
      ConversionPathEntry(LuaContext* c, const Napi::Value& v) : ctx(c) {
        ctx->conversion_path_.push_back(v);
      }
      ~ConversionPathEntry() { ctx->conversion_path_.pop_back(); }
    };

    // True if `v` is already an ancestor of itself on the current path.
    [[nodiscard]] bool IsOnConversionPath(const Napi::Value& v) const;

    // --- reset() support -------------------------------------------------
    // State that is *context* configuration rather than Lua-state contents, so
    // reset() can replay it onto the replacement runtime. Everything a reset
    // does NOT replay (modules, userdata, classes, metatables) is bound to
    // Lua-side objects that die with the old state; see reset()'s docs.
    //
    // The callbacks object handed to the constructor. Held as a strong
    // reference so the same functions can be re-registered on a fresh state.
    Napi::ObjectReference callbacks_ref_;
    // Mirrors runtime->SetAllowBytecode: the E3 guard is applied after
    // construction, so it isn't carried by RuntimeConfig.
    bool allow_bytecode_ = true;

    // `filesystem: 'deny'` (T2). Mirrors runtime->SetFilesystemAccess for the
    // same reason as the flag above: the seal is applied after the libraries
    // are open, so reset() has to re-apply it to the fresh state.
    bool filesystem_denied_ = false;

    // `tableAs: 'map'` (T1). The core keeps plain tables by reference under
    // this mode; this flag is what tells CoreToNapiBuiltin to materialize one
    // as a Map rather than hand back a live Proxy.
    bool table_as_map_ = false;

    // C2: set by close(), never cleared. Every guard consults it, so a closed
    // context refuses instead of touching a state that is gone. The shared flag
    // beside it is the one handles read — minted once, so a handle taken before
    // the close sees the same object the close flips.
    bool closed_ = false;
    std::shared_ptr<std::atomic<bool>> closed_flag_ =
        std::make_shared<std::atomic<bool>>(false);

    // `binaryStrings`: return every Lua string as a Uint8Array of its raw bytes
    // instead of decoding it as UTF-8 (LIMITATIONS.md §2).
    //
    // **Off by default and deliberately not data-dependent.** Lua strings are
    // byte strings; JS strings are UTF-16, so a byte sequence that is not valid
    // UTF-8 cannot survive the default decode and comes back with U+FFFD in
    // place of each bad byte. The tempting fix — decode when it *is* valid UTF-8
    // and hand back bytes when it is not — makes the return type depend on the
    // data, which is the defect class this project's reviews kept finding (a
    // value that looks right until the input changes). So this is a per-context
    // switch: either every string is text, or every string is bytes, and the
    // caller knows which.
    //
    // Table *keys* are unaffected — they are set with the std::string directly
    // rather than through CoreToNapiBuiltin, and a JS property key has to be a
    // string regardless.
    bool binary_strings_ = false;
    // Search paths added via add_search_path, in the order they were added.
    std::vector<std::string> search_paths_;
    // Searcher functions added via add_searcher, in the order they were added.
    // A JS searcher is context configuration exactly like a search path — it
    // lives in JS, not in the retiring Lua state — so reset() replays it rather
    // than silently dropping it (CR-9 F3).
    std::vector<Napi::FunctionReference> searchers_;
    // SharedTables this context subscribed to via the `shared` init option,
    // paired with the global name each is published under. Held strongly (the
    // subscription is context configuration, and a SharedTable is a small JS
    // object); the SharedTable's own reference back to this context is weak, so
    // there is no cycle. reset() replays these onto the fresh state.
    std::vector<std::pair<Napi::ObjectReference, std::string>> shared_tables_;

    // Installs the runtime-side handlers that bridge back into this context
    // (userdata GC, host-function GC, proxy property access). Shared by the
    // constructor and reset(), which must re-arm them on the new state.
    void InstallRuntimeHandlers();
    // Unbinds the outgoing runtime from this context so nothing it does during
    // teardown (lua_close fires __gc) reaches a member being torn down or
    // repopulated. Shared by ~LuaContext and reset().
    void DetachRuntimeHandlers() const;

    void RegisterCallbacks(const Napi::Object& callbacks);
    lua_core::LuaRuntime::Function CreateJsCallbackWrapper(const std::string& name);
    lua_core::LuaRuntime::Function CreateConstructorWrapper(
        const std::string& name, const std::string& class_name,
        bool readable, bool writable);
};
