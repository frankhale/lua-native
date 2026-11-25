// The WASM target's JavaScript shell.
//
// The build copies this file beside the Emscripten output as `lua-native.mjs`
// (`tools/wasm-build/run.mjs`), once per variant, so the relative import below
// resolves to that variant's own module. It is the one file a loader imports.
//
// It holds only what has to be JavaScript (`docs/reviews/WASM-TARGET-PLAN.md` D2):
//
//   - `host`: the guarded primitives every C++ -> JS operation goes through, so
//     that a JavaScript exception never unwinds through a WASM frame;
//   - the `LuaContext` class object, a thin face over the C++ `LuaContext`;
//   - `SharedTable`, which is JS-side state with no C++ half on either target;
//   - the `FinalizationRegistry` that frees a context's C++ side.
//
// **No policy lives here.** Liveness, busy, re-entrancy and cross-context
// refusals are decided in C++ (`src/wasm/lua-wasm.cpp`), as they are natively.
// A method on `LuaContext` below does three things and no others: hand over
// `arguments`, check for the failure sentinel, return. The one thing this file
// does that the native binding has no need to is under "foreign exceptions".
//
// Top-level `await`: a WASM module cannot be instantiated synchronously on a
// browser's main thread, and the native default export is usable the moment it
// is imported. Awaiting here is what keeps that true of this one.
//
// Written in seven slices (plan, Phase 2), all of which are here: every method
// the native binding has, this one has.

import createCore from './lua-native-core.mjs';

const core = await createCore();

// Intrinsics, captured before any user code can run. The brand checks below
// call these directly so that a patched global, a `Symbol.hasInstance` or a
// shadowing own property cannot change what a value is taken to be.
const { apply: reflectApply, construct: reflectConstruct, set: reflectSet } = Reflect;
const defineProperty = Object.defineProperty;
const freeze = Object.freeze;
const ProxyCtor = Proxy;
const symbolIterator = Symbol.iterator;
const symbolAsyncIterator = Symbol.asyncIterator;
const PromiseCtor = Promise;
const WeakRefCtor = WeakRef;
const weakRefDeref = WeakRef.prototype.deref;
// A later task, which is where a worker's completion arrives natively.
const setTimer = globalThis.setTimeout;
const laterTask = typeof setTimer === 'function'
  ? (run) => { setTimer(run, 0); }
  : (run) => { PromiseCtor.resolve().then(run); };
const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
const U8 = Uint8Array;
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = getter(typedArrayProto, 'buffer');
const typedArrayOffset = getter(typedArrayProto, 'byteOffset');
const typedArrayLength = getter(typedArrayProto, 'byteLength');
const arrayBufferLength = getter(ArrayBuffer.prototype, 'byteLength');
const isView = ArrayBuffer.isView;
const isArray = Array.isArray;
const dateGetTime = Date.prototype.getTime;
const promisePrototype = Promise.prototype;
const promiseResolve = Promise.resolve;
const promiseThen = Promise.prototype.then;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const ignore = () => {};
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const asIntN = BigInt.asIntN;
const asUintN = BigInt.asUintN;
const ERRORS = [Error, TypeError, RangeError];
const captureStackTrace = Error.captureStackTrace;

// An error the binding constructs, its `stack` beginning at the JavaScript
// that called in, as it does natively. `door` is the function the caller
// called: everything from it inward is the binding's. It is named by identity
// and not by source URL because a bundler may put this file and the caller's
// in one. An engine without `captureStackTrace` keeps the stack it made.
//
// `door` must be on the call stack: for one that is not, the engine's answer
// is a stack with no frames at all.
//
// V8 skips JavaScript frames up to `door` and no WASM frame, so those are cut
// from the text, and the limit is raised while it looks so that they do not
// use it up. Reading `stack` runs `Error.prepareStackTrace` if there is one,
// which can throw and can answer with anything; either leaves the stack alone.
const ErrorCtor = Error;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const WASM_FRAME = /^\s+at .*wasm-function\[/;
const WASM_FRAMES = 64;  // more than a debug build puts between two JS frames
const makeError = (Ctor, message, door) => {
  const error = new Ctor(message);
  if (typeof captureStackTrace !== 'function') return error;
  try {
    const limit = getOwnPropertyDescriptor(ErrorCtor, 'stackTraceLimit');
    const raise = limit !== undefined && limit.writable === true &&
      typeof limit.value === 'number' && limit.value > 0;
    if (raise) ErrorCtor.stackTraceLimit = limit.value + WASM_FRAMES;
    try {
      captureStackTrace(error, door);
    } finally {
      if (raise) ErrorCtor.stackTraceLimit = limit.value;
    }
    const { stack } = error;
    const header = `${error.name}: ${message}\n`;
    if (!raise || typeof stack !== 'string' || !stack.startsWith(header)) return error;
    const frames = stack.slice(header.length).split('\n');
    let first = 0;
    while (first < frames.length && WASM_FRAME.test(frames[first])) ++first;
    error.stack = (header + frames.slice(first, first + limit.value).join('\n')).trimEnd();
  } catch { /* the stack it was made with will do */ }
  return error;
};

const encoder = new TextEncoder();
// `ignoreBOM: true` keeps a leading U+FEFF, which the default strips.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

const brand = (probe, value) => {
  try {
    reflectApply(probe, value, []);
    return true;
  } catch {
    return false;
  }
};

// --- the failure protocol ---------------------------------------------------
//
// A guarded host function never throws: it returns FAILED and parks the thrown
// value, which C++ collects with `takeThrown` and rethrows as a C++ exception.
// Its handler parks the value **inline, without calling anything**: when what
// it caught is the call stack running out, a call from the handler is the
// next overflow, thrown this time from where nothing guards it.
// In the other direction, C++ parks a pending exception with `setPending` and
// returns FAILED from the entry point; `unwrap` throws it.
const FAILED = Object.freeze({ __proto__: null });
let thrown;
let pending;

const takePending = () => {
  const value = pending.value;
  pending = undefined;
  return value;
};

const unwrap = (result) => {
  if (result === FAILED) throw takePending();
  return result;
};

const KIND = {
  undefined: 0, boolean: 2, number: 3, string: 4, symbol: 5, function: 6, bigint: 7, object: 8,
};
const KIND_EXTERNAL = 9;

// --- foreign exceptions -----------------------------------------------------
//
// Every call from here into the module goes through `enter`. By the protocol
// above nothing is ever thrown out of one: C++ catches its own exceptions and
// returns FAILED. What can still come out is a *JavaScript* exception that was
// raised above WASM frames and unwound them. In practice that is the engine's
// call stack running out — a `RangeError` raised in the glue, or by the
// engine's own check inside a WASM function.
//
// Natively this cannot happen: N-API reports a JS exception as a status, and
// native frames are not unwound by it. Here nothing in the module can stop it:
//
//   - C++ cannot catch it. `catch (...)` does not see a JavaScript exception,
//     and when the engine's check fires inside WASM not even destructors run.
//   - Lua's protected calls do not see it either, so the Lua frames it crossed
//     are abandoned with Lua's handler chain still pointing into them. The
//     next Lua error then jumps to a handler in a frame that is gone.
//
// (All three measured November 24, 2026; `tools/wasm-build/check.mjs` has the
// cells.) So the one place it can be seen is here, and what this does is make
// it **fail closed**:
//
//   - A context whose C++ side was unwound is refused from then on — it and
//     every handle it minted, through the `state` record they share. Neither
//     its Lua state nor the binding's own bookkeeping can be trusted, and
//     neither can be repaired from outside.
//   - A run that was in flight on it (`execute_async` and its siblings) can no
//     longer be driven, so its promise is rejected the next time anything
//     would have driven it, rather than left pending for good.
//   - "Was unwound" is read, not inferred: C++ counts each entry point as it
//     begins, in the module's memory. If a call threw and the count moved, C++
//     had started. A `RangeError` raised before that — a caller already at the
//     edge of the stack — harmed nothing and poisons nothing.
//   - The jump to a dead handler arrives as a bare `WebAssembly.Exception`
//     that nothing claims. It is replaced by an error saying what happened.
//   - The module's stack pointer is restored by each function as it returns.
//     Unwound frames never did, so it is put back once no call into the module
//     is in progress; otherwise each such event would cost the module, and
//     every other context in it, that much stack for good.
//
// What this does **not** cover is recorded in the plan (Slice 2): an overflow
// that lands inside the module's allocator can damage state every context
// shares, and nothing here can tell.
//
// The handler calls nothing unless it must: it may be running with no stack
// to spare, where a call is the next overflow.
const WasmException = WebAssembly.Exception;
const entriesBegunAt = core.entryCounterAddress() >>> 2;  // an index into HEAPU32
const stackBase = core.stackSave();
let depth = 0;
let stackAbandoned = false;
// The door of the innermost call into the module (see makeError).
let currentDoor;

// --- headroom -----------------------------------------------------------------
//
// The engine's stack running out inside the module is the one thing above that
// cannot be put right, so it is not let happen. Before each call into the
// module, and every few levels of anything in it that recurses (stack.cpp),
// this asks whether there is still room; the answer no is an ordinary error.
//
// The question is a call with that many arguments, which the engine must find
// room for and which does nothing. Running out of stack *here* is a RangeError
// in JavaScript with nothing of the module's above it, so it is caught. The
// callee is a builtin so that no engine can inline the call and its frame away.
//
// How much room is enough is measured, not assumed, once per module (see
// "calibration", at the end): a frame is several times larger in one engine
// than in another. Until then it is this, which is generous for the
// calibration's own shallow run.
const FRAME_UNITS = 32;  // Lua C levels' worth of stack to keep in hand
let headroom = new Array(8192).fill(0);
const hasHeadroom = () => {
  try {
    reflectApply(isArray, undefined, headroom);
    return true;
  } catch {
    return false;
  }
};
core.stackHeadroom = hasHeadroom;

const UNWOUND =
  'lua-native: this Lua context can no longer be used. A JavaScript exception (most ' +
  'likely the call stack overflowing) unwound it while it was running, which leaves the ' +
  'Lua state inconsistent. Create a new context.';

// `state` is the record of the context the call belongs to, or undefined for a
// call that belongs to none yet (construction) or no longer (finalization).
// `door` is the function the caller called, or undefined when there is none.
const enter = (state, object, name, args, door) => {
  if (state !== undefined && state.unwound) throw makeError(Error, UNWOUND, door ?? enter);
  // What the engine would have said a moment later, while it still costs nothing.
  if (!hasHeadroom()) throw new RangeError('Maximum call stack size exceeded');
  if (depth === 0 && stackAbandoned) {
    core.stackRestore(stackBase);
    stackAbandoned = false;
  }
  // Read through `core` each time: growing the memory replaces the view.
  const begun = core.HEAPU32[entriesBegunAt];
  const outerDoor = currentDoor;
  currentDoor = door ?? enter;
  ++depth;
  try {
    return object[name](args);
  } catch (error) {
    stackAbandoned = true;
    if (core.HEAPU32[entriesBegunAt] !== begun) {
      if (state !== undefined) state.unwound = true;
      if (error instanceof WasmException) throw new Error(UNWOUND, { cause: error });
    }
    throw error;
  } finally {
    --depth;
    currentDoor = outerDoor;
  }
};

// --- suspension -----------------------------------------------------------------
//
// A deferred run (`execute_script_async`, `execute_file_async`) holds the only
// thread there is. Where the engine has JavaScript Promise Integration, the run
// gives it back every few milliseconds: the whole call into the module is
// suspended, the event loop has its turn, and the call goes on where it was.
// Nothing of JavaScript's may be on the stack between, and nothing is: these
// runs are refused every callback into JavaScript, as on a worker.
//
// The engine keeps the call's frames. It does not keep the module's *own* stack,
// which is a region of its memory with one pointer into it, and anything else
// that runs meanwhile would write over it. So such a run has a region to
// itself, and the pointer is switched at each of the four places control
// crosses. That is done from WASM, by the few instructions below, because when a
// suspended call goes on the engine goes straight back into WASM:
//
//   run(run, top)  restore(top); execute(run); restore(0)
//   pause()        sp = save(); suspend(); restore(sp)
//
// A `restore` of 0 means the module's main stack, with nothing on it: control
// leaves such a run only for the event loop.
const SUSPENSION = new U8([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 17, 4, 96, 0, 0, 96, 1, 127, 0, 96, 0, 1, 127, 96, 2, 127, 127,
  0, 2, 44, 4, 1, 101, 4, 115, 97, 118, 101, 0, 2, 1, 101, 7, 114, 101, 115, 116, 111, 114, 101, 0,
  1, 1, 101, 7, 101, 120, 101, 99, 117, 116, 101, 0, 1, 1, 101, 5, 112, 97, 117, 115, 101, 0, 0, 3,
  3, 2, 3, 0, 7, 15, 2, 3, 114, 117, 110, 0, 4, 5, 112, 97, 117, 115, 101, 0, 5, 10, 31, 2, 14, 0,
  32, 1, 16, 1, 32, 0, 16, 2, 65, 0, 16, 1, 11, 14, 1, 1, 127, 16, 0, 33, 0, 16, 3, 32, 0, 16, 1,
  11]);
const { Suspending, promising } = WebAssembly;

// The event loop's next turn. `setTimeout` is the last resort: a browser makes
// nested ones wait four milliseconds, which is half of every slice.
const nextTurn = (() => {
  const immediate = globalThis.setImmediate;
  if (typeof immediate === 'function') return (go) => { immediate(go); };
  if (typeof MessageChannel !== 'function') return laterTask;
  const waiting = [];
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => { waiting.shift()(); };
  // Every fourth is a timer all the same: a Safari worker runs a message before
  // any timer that is due, so a run that only posted messages starved them, and
  // a cancel() from one never came.
  let turns = 0;
  return (go) => {
    turns += 1;
    if (turns % 4 === 0) {
      laterTask(go);
    } else {
      waiting.push(go);
      port2.postMessage(null);
    }
  };
})();

// The stacks of the runs in flight: [bottom, top].
const regions = new Set();
// A debug build checks the stack pointer against limits, which move with it.
const setLimits = core.___set_stack_limits;
const mainBottom = setLimits === undefined ? 0 : core._emscripten_stack_get_end();
const mainTop = setLimits === undefined ? 0 : core._emscripten_stack_get_base();

const switchStack = (sp) => {
  if (setLimits !== undefined) {
    let bottom = mainBottom;
    let top = mainTop;
    for (const region of regions) {
      if (sp !== 0 && sp >= region[0] && sp <= region[1]) [bottom, top] = region;
    }
    setLimits(top, bottom);
  }
  core.stackRestore(sp === 0 ? stackBase : sp);
};

// Runs `run`'s script to its end, suspending as it goes; a promise of that.
// Undefined where the engine cannot.
const suspendableExecute = (() => {
  if (typeof Suspending !== 'function' || typeof promising !== 'function') return undefined;
  try {
    const table = core.wasmTable;
    const { exports } = new WebAssembly.Instance(new WebAssembly.Module(SUSPENSION), {
      e: {
        save: () => core.stackSave(),
        restore: switchStack,
        execute: table.get(core.LuaWorkerRun.executeEntry()),
        pause: new Suspending(() => {
          switchStack(0);
          return new PromiseCtor(nextTurn);
        }),
      },
    });
    table.grow(1);
    table.set(table.length - 1, exports.pause);
    core.LuaWorkerRun.setPause(table.length - 1);
    return promising(exports.run);
  } catch {
    return undefined;  // refused by a content security policy, or not all there
  }
})();

// Frees a C++ object when the JS object that stands for it is collected — the
// role an N-API finalizer plays natively. It runs in a later task than the
// collection. Contexts and Lua functions both register here.
const handles = new FinalizationRegistry((handle) => enter(undefined, handle, 'delete'));

// Native: DefineHiddenProp. A marker that JS can neither delete nor (unless
// `writable`) reassign, so the C++ object behind a still-callable function
// cannot be freed out from under it (L6).
const defineHidden = (object, key, value, writable) => {
  defineProperty(object, key, { value, writable, enumerable: false, configurable: false });
};

// --- handles ------------------------------------------------------------------
//
// A Lua function, a table handle, a metatabled table's Proxy, a table iterator,
// a userdata Lua created, a coroutine, a coroutine cursor and an await's
// continuation each stand for a C++ struct. Natively that struct sits behind an
// N-API External: an opaque object whose finalizer frees the struct, carrying
// a type tag that says which kind it is, and rooted on everything that can
// still reach the struct. Each of those four jobs has a counterpart here.
//
//   opaque     the *owner*: a frozen object with no prototype and no properties
//   finalizer  the owner is registered with `handles`, so the struct is freed
//              when nothing can reach the owner any more
//   type tag   one WeakMap per kind, owner -> struct. Being a key of the map
//              for a kind *is* the tag, so an owner re-presented under another
//              marker's name is still only what it was minted as (CR-15 F6)
//   rooting    the owner is a hidden, non-configurable property of the handle
//              and of every function that calls through to the struct, so a
//              method destructured off a handle keeps the struct alive, and
//              `delete` cannot free it out from under one (H3 / L6)
//
// `release`, which looks a handle up by its owner, arrives with slice 7.
//
// To the binding an External is not an object: it fails every "is this an
// object" check and converts to nil. So an owner is its own *kind* here too
// (`host.kind`), and `externals` is how one is told from a plain object.
const externals = new WeakSet();
const weakSetHas = WeakSet.prototype.has;
const functionOwners = new WeakMap();
const tableOwners = new WeakMap();
const userdataOwners = new WeakMap();
const threadOwners = new WeakMap();
// A coroutine cursor's owner -> what its async `next` needs to build the
// function that maps a settled step (see `coroAsyncMapper`).
const coroIterators = new WeakMap();
// Natively a cursor's state is rooted by a *separate* External on the iterator
// and on each of its methods, all sharing ownership of it. Here each such root
// is its own object that keeps the one real owner alive.
const ownerRoots = new WeakMap();
const rootFor = (owner) => {
  const root = freeze({ __proto__: null });
  externals.add(root);
  ownerRoots.set(root, owner);
  return root;
};
// A class instance's `__luaClassOwner`: owner -> the id of the runtime that
// constructed it. Natively an External wrapping the runtime's address, which
// owns nothing; this one owns nothing either and is registered nowhere.
const runtimeOwners = new WeakMap();
// A table iterator reads through its table's struct without owning it, so the
// table's owner is kept alive for as long as the iterator's is.
const iteratorTables = new WeakMap();

// The `this` an N-API function sees. Such a function is not strict code, so a
// missing receiver arrives as the global object and a primitive one as its
// wrapper — `info.This()` is always an object. The functions here are strict,
// so they say it themselves wherever C++ is handed the receiver.
const ObjectCtor = Object;
const receiverOf = (self) => (self === undefined || self === null ? globalThis : ObjectCtor(self));

// What a function the binding hands out looks like natively: V8 makes one that
// is not strict, so it has own `arguments` and `caller`, and its source text is
// `[native code]`. A module's functions are all strict, so the two properties
// are defined by hand with V8's descriptors, and a Proxy with no traps hides
// the source: the one ordinary callable whose text an engine will not show,
// that still passes `this` through. (A bound function would not.) What cannot
// be had is the name inside that text. The handler has no prototype, so
// nothing put on Object.prototype can become a trap.
const NO_TRAPS = freeze({ __proto__: null });
const nativeFunction = (body) => {
  defineHidden(body, 'arguments', null, false);
  defineHidden(body, 'caller', null, false);
  const fn = new ProxyCtor(body, NO_TRAPS);
  defineProperty(body.prototype, 'constructor', { value: fn, writable: true, enumerable: false, configurable: true });
  return fn;
};

// A function that answers with its receiver: an iterator's own
// `[Symbol.iterator]` or `[Symbol.asyncIterator]`.
const selfFunction = (name) => {
  const fn = function () { return receiverOf(this); };
  defineProperty(fn, 'name', { value: name, configurable: true });
  return nativeFunction(fn);
};
const weakMapGet = WeakMap.prototype.get;

const mintOwner = (owners, handle) => {
  const owner = freeze({ __proto__: null });
  externals.add(owner);
  if (owners !== undefined) owners.set(owner, handle);
  handles.register(owner, handle);
  return owner;
};

// The struct behind an owner of one kind, or null for anything else.
const taggedData = (owners, owner) =>
  (typeof owner === 'object' && owner !== null && reflectApply(weakMapGet, owners, [owner])) || null;

// A function that looks like the N-API function it stands for: named `name`,
// reporting length 0, with a `prototype`. `rootKey` is the hidden property
// that roots `owner` on it. `rootedFunction` is the same without the N-API
// look, for a function no caller can reach.
const rootedFunction = (name, rootKey, owner, body) => {
  defineProperty(body, 'name', { value: name, configurable: true });
  defineHidden(body, rootKey, owner, false);
  return body;
};
const handleFunction = (name, rootKey, owner, body) =>
  nativeFunction(rootedFunction(name, rootKey, owner, body));

const TABLE_METHODS = ['get', 'get_ref', 'set', 'has', 'length', 'pairs', 'ipairs', 'keys', 'release'];
const TABLE_TRAPS = {
  get: 'trapGet',
  set: 'trapSet',
  has: 'trapHas',
  ownKeys: 'trapOwnKeys',
  getOwnPropertyDescriptor: 'trapGetOwnPropertyDescriptor',
};

const host = {
  failed: FAILED,

  takeThrown() {
    const { value } = thrown;
    thrown = undefined;
    return value;
  },
  setPending(value) {
    pending = { value };
  },

  // What `Napi::Error::what()` reads: `.message` when it is a string.
  errorMessage(value) {
    try {
      const message = value.message;
      return typeof message === 'string' ? message : '';
    } catch {
      return '';
    }
  },
  newError(type, message) {
    return makeError(ERRORS[type], message, currentDoor ?? host.newError);
  },

  // --- classification: no user code ----------------------------------------
  kind(value) {
    if (value === null) return 1;
    const kind = KIND[typeof value];
    return kind === 8 && reflectApply(weakSetHas, externals, [value]) ? KIND_EXTERNAL : kind;
  },
  // 0 plain, 1 array, 2 binary (an ArrayBuffer view or an ArrayBuffer), 3 Date.
  objectKind(value) {
    if (isView(value) || brand(arrayBufferLength, value)) return 2;
    if (brand(dateGetTime, value)) return 3;
    return isArray(value) ? 1 : 0;
  },
  // N-API asks V8 whether the value *is* a promise. JavaScript has two ways to
  // put that question to the engine, and each has an effect on one of the two
  // answers, so they are used where they have none:
  //
  //   `Promise.resolve` hands a promise back as itself and does nothing to it.
  //   On anything else it reads `then` and adopts it, so it is asked only of
  //   an object that has none of its own.
  //   `then` refuses anything else before doing anything. On a promise it
  //   attaches a reaction and consults its species.
  //
  // Neither is cheap, and almost every value here is a plain object or an array,
  // so those two are told by their prototype and not asked. Anything else is:
  // a promise made in another realm (an iframe's) has that realm's prototype, and
  // the engine knows it for a promise all the same. A Proxy's traps can throw.
  isPromise(value) {
    try {
      if (typeof value !== 'object' || value === null) return false;
      const proto = getPrototypeOf(value);
      if (proto === objectPrototype || proto === arrayPrototype) return false;
      if (proto === promisePrototype && !hasOwn(value, 'then') && !hasOwn(value, 'constructor')) {
        const same = reflectApply(promiseResolve, PromiseCtor, [value]);
        if (same === value) return true;
        reflectApply(promiseThen, same, [undefined, ignore]);
      }
      // A subclass, another realm's, one with properties of its own, or not one.
      reflectApply(promiseThen, value, [undefined, ignore]);
      return true;
    } catch {
      return false;
    }
  },
  dateValue(value) {
    return reflectApply(dateGetTime, value, []);
  },
  // What `napi_is_buffer` answers: any ArrayBuffer view, a DataView included,
  // and not an ArrayBuffer itself.
  isBufferView(value) {
    return isView(value);
  },
  fitsInt64(value) {
    return asIntN(64, value) === value;
  },
  fitsUint64(value) {
    return asUintN(64, value) === value;
  },
  // What `napi_get_value_int32` gives for a number.
  int32(value) {
    return value | 0;
  },

  // --- handles: no user code ---------------------------------------------------
  // Native: FunctionRefToNapi's JS half. A `function` expression and not an
  // arrow or a method: like the N-API function it stands for it is named
  // `luaFunction`, reports length 0, and has a `prototype`.
  luaFunction(handle, state) {
    const fn = function luaFunction(...args) {
      return unwrap(enter(state, handle, 'call', args, luaFunction));
    };
    defineHidden(fn, '__luaFnOwner', mintOwner(functionOwners, handle), false);
    return nativeFunction(fn);
  },
  // Native: CreateTableHandle's JS half. A plain object whose own enumerable
  // properties are its nine methods, plus the iterator and the hidden marker.
  tableHandle(handle, state) {
    const owner = mintOwner(tableOwners, handle);
    const object = {};
    defineHidden(object, '_tableRef', owner, false);
    for (const name of TABLE_METHODS) {
      object[name] = handleFunction(name, '_tableOwner', owner, function door(...args) {
        return unwrap(enter(state, handle, name, args, door));
      });
    }
    // The C++ side wants two things an N-API callback reads off its `info`:
    // `this`, and something that keeps the table alive under the iterator.
    object[symbolIterator] = handleFunction('[Symbol.iterator]', '_tableOwner', owner, function door() {
      return unwrap(enter(state, handle, 'iterator', [receiverOf(this), owner], door));
    });
    return object;
  },
  // Native: TableRefToNapi's JS half. The target's `_tableRef` stays
  // configurable so that `ownKeys` may omit it; each trap roots the owner
  // itself, so deleting the marker through the Proxy frees nothing (H3).
  tableProxy(handle, state) {
    const owner = mintOwner(tableOwners, handle);
    const target = {};
    defineProperty(target, '_tableRef', { value: owner, enumerable: false, configurable: true });
    const handler = {};
    for (const trap in TABLE_TRAPS) {
      const method = TABLE_TRAPS[trap];
      handler[trap] = rootedFunction(trap, '_tableOwner', owner, function door(...args) {
        return unwrap(enter(state, handle, method, args, door));
      });
    }
    return new ProxyCtor(target, handler);
  },
  // Native: TaggedData<LuaTableRefData>. The struct behind a `_tableRef`
  // owner, or null for anything that is not one.
  tableData(owner) {
    return taggedData(tableOwners, owner);
  },
  // Native: UserdataRefToNapi's JS half, for a userdata Lua created. A plain
  // object whose one own property is the marker — enumerable, writable and
  // configurable, as `handle.Set("_userdata", owner)` leaves it.
  userdataHandle(handle) {
    return { _userdata: mintOwner(userdataOwners, handle) };
  },
  // Native: TaggedData<LuaUserdataData>.
  userdataData(owner) {
    return taggedData(userdataOwners, owner);
  },
  // Native: the `__luaClassOwner` External a constructed instance is stamped
  // with. `id` is the constructing runtime's, a BigInt.
  runtimeOwner(id) {
    const owner = freeze({ __proto__: null });
    externals.add(owner);
    runtimeOwners.set(owner, id);
    return owner;
  },
  // Native: TaggedData<LuaRuntime>(owner, kRuntimeOwner), as the id it wraps.
  runtimeOwnerId(owner) {
    if (typeof owner !== 'object' || owner === null) return null;
    const id = reflectApply(weakMapGet, runtimeOwners, [owner]);
    return id === undefined ? null : id;
  },
  // Native: TableHandleSymbolIterator's JS half.
  tableIterator(handle, state, tableOwner) {
    const owner = mintOwner(undefined, handle);
    iteratorTables.set(owner, tableOwner);
    const iterator = {};
    defineHidden(iterator, '__tableIterOwner', rootFor(owner), false);
    iterator.next = handleFunction('next', '__tableIterOwner', rootFor(owner), function door(...args) {
      return unwrap(enter(state, handle, 'next', args, door));
    });
    iterator[symbolIterator] = selfFunction('[Symbol.iterator]');
    return iterator;
  },

  // --- coroutines and promises: no user code -----------------------------------
  // Native: TaggedData<LuaFunctionData> and TaggedData<LuaThreadData>.
  functionData(owner) {
    return taggedData(functionOwners, owner);
  },
  threadData(owner) {
    return taggedData(threadOwners, owner);
  },
  // Native: CreateCoroutineObject's JS half. A plain object: the marker and
  // `status` are ordinary properties, and each of the two iterator factories
  // roots its own binding.
  coroutineObject(thread, binding, asyncBinding, status, state) {
    const coro = { _coroutine: mintOwner(threadOwners, thread), status };
    coro[symbolIterator] = handleFunction(
      '[Symbol.iterator]', '__coroBindingOwner', mintOwner(undefined, binding), function door() {
        return unwrap(enter(state, binding, 'iterator', [receiverOf(this)], door));
      });
    coro[symbolAsyncIterator] = handleFunction(
      '[Symbol.asyncIterator]', '__coroBindingOwner', mintOwner(undefined, asyncBinding), function door() {
        return unwrap(enter(state, asyncBinding, 'asyncIterator', [receiverOf(this)], door));
      });
    return coro;
  },
  // Native: the iterator CoroSymbolIterator and CoroSymbolAsyncIterator build.
  coroIterator(handle, state, isAsync) {
    const owner = mintOwner(undefined, handle);
    coroIterators.set(owner, { handle, state });
    const iterator = {};
    defineHidden(iterator, '__coroIterOwner', rootFor(owner), false);
    if (isAsync) {
      // The async `next` hands C++ the owner as well: the function that maps
      // the settled step must root the cursor, and can outlive this one.
      iterator.next = handleFunction('next', '__coroIterOwner', rootFor(owner), function door(...args) {
        return unwrap(enter(state, handle, 'asyncNext', [owner, args], door));
      });
    } else {
      iterator.next = handleFunction('next', '__coroIterOwner', rootFor(owner), function door(...args) {
        return unwrap(enter(state, handle, 'next', args, door));
      });
    }
    iterator.return = handleFunction('return', '__coroIterOwner', rootFor(owner), function door(...args) {
      return unwrap(enter(state, handle, 'return', args, door));
    });
    if (isAsync) {
      iterator[symbolAsyncIterator] = selfFunction('[Symbol.asyncIterator]');
    } else {
      iterator[symbolIterator] = selfFunction('[Symbol.iterator]');
    }
    return iterator;
  },
  // Native: the `mapper` CoroAsyncIteratorNext hands to `then`.
  coroAsyncMapper(owner) {
    const { handle, state } = reflectApply(weakMapGet, coroIterators, [owner]);
    return handleFunction('next', '__coroIterOwner', rootFor(owner), function door(...args) {
      return unwrap(enter(state, handle, 'map', args, door));
    });
  },
  // Native: Napi::Promise::Deferred. The intrinsic constructor, so a patched
  // global changes nothing; neither settling function can throw.
  deferred() {
    let resolve;
    let reject;
    const promise = new PromiseCtor((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  },
  // Native: the two continuations AttachToAwaitedPromise hands to `then`, both
  // rooting the one cookie. If the context was unwound while the run was
  // suspended there is nothing left to drive: the run's promise is rejected
  // here, in a job of its own with the whole stack to use.
  awaitCallbacks(cookie, state) {
    const owner = mintOwner(undefined, cookie);
    const make = (name, method) => {
      const fn = function door(...args) {
        if (state.unwound) {
          const run = state.run;
          state.run = undefined;
          if (run !== undefined) run.reject(new Error(UNWOUND));
          return undefined;
        }
        return unwrap(enter(state, cookie, method, args, door));
      };
      defineProperty(fn, 'name', { value: name, configurable: true });
      defineHidden(fn, '__cookie', owner, true);
      return nativeFunction(fn);
    };
    return [make('onResolve', 'resolve'), make('onReject', 'reject')];
  },
  // Native: AsSharedTable, SharedTable::Subscribe and SharedTable::PushTo.
  // The last two push through the context's public `set_global`, which is
  // user-reachable code, so they are guarded.
  isSharedTable(value) {
    return isSharedTable(value);
  },
  sharedSubscribe(table, context, name) {
    try { subscribeShared(table, context, name); return undefined; } catch (error) { thrown = { value: error }; return FAILED; }
  },
  sharedPush(table, context, name) {
    try { pushShared(table, context, name); return undefined; } catch (error) { thrown = { value: error }; return FAILED; }
  },
  // The context's own JS object, or undefined once it has been collected.
  // Native: `info.This()` / `ObjectWrap::Value()`.
  contextSelf(state) {
    return reflectApply(weakRefDeref, state.self, []);
  },
  // Native: `worker->Queue()`. The run is taken up in a later task, as a
  // worker's completion is; see D3 in the plan for what differs.
  schedule(run, state, deferred) {
    const settle = (method, door) => {
      try {
        unwrap(enter(state, run, method, [], door));
      } catch (error) {
        deferred.reject(error);
      } finally {
        try { enter(undefined, run, 'delete'); } catch { /* nothing left to release it with */ }
      }
    };
    laterTask(function door() {
      let top = 0;
      // 0 when there is no memory for a stack: run it without.
      if (suspendableExecute !== undefined && !state.unwound) top = run.stackTop();
      if (top === 0) {
        settle('run', door);
        return;
      }
      const region = [run.stackBottom(), top];
      regions.add(region);
      const over = suspendableExecute(run.address(), top);
      reflectApply(promiseThen, over, [
        () => {
          regions.delete(region);
          settle('finish', undefined);
        },
        (error) => {
          // As in `enter`: frames were unwound that could not clean up. The
          // run's struct is one of the things that cannot be trusted now.
          regions.delete(region);
          switchStack(0);
          state.unwound = true;
          deferred.reject(error instanceof WasmException ? new Error(UNWOUND, { cause: error }) : error);
        },
      ]);
    });
  },

  // --- strings and bytes: no user code, but guarded --------------------------
  //
  // None of these runs user code, and each can still throw: a Lua string
  // longer than the engine's longest string cannot be decoded, an allocation
  // can be refused, a buffer can have been detached. Slices 1 to 4 left them
  // unguarded, so such a throw unwound the module and cost the caller the
  // whole context, where natively it is an ordinary error (found in slice 5 by
  // the suite's 600 MB result).

  // A lone surrogate encodes as U+FFFD, as it does in napi_get_value_string_utf8.
  utf8(string) {
    try { return encoder.encode(string); } catch (error) { thrown = { value: error }; return FAILED; }
  },
  // An invalid sequence decodes as U+FFFD, as it does in napi_create_string_utf8.
  string(view) {
    try { return decoder.decode(view); } catch (error) { thrown = { value: error }; return FAILED; }
  },
  bytesView(value) {
    try {
      if (!isView(value)) return new U8(value);
      if (brand(typedArrayLength, value)) {
        return new U8(reflectApply(typedArrayBuffer, value, []),
          reflectApply(typedArrayOffset, value, []), reflectApply(typedArrayLength, value, []));
      }
      // A DataView. The native binding asks N-API for it as a Buffer, which
      // N-API first agrees it is and then refuses to read, so every door that
      // takes bytes fails on one with this message. Kept, not improved on: a
      // program must meet the same answer on both targets (plan, D2). In place
      // as a silent conversion from slice 1 until slice 6's diff found it.
      throw host.newError(0, 'Invalid argument');
    } catch (error) {
      thrown = { value: error };
      return FAILED;
    }
  },
  newBytes(view) {
    try { return new U8(view); } catch (error) { thrown = { value: error }; return FAILED; }
  },

  // --- guarded: each of these can run user code -----------------------------
  get(object, key) {
    try { return object[key]; } catch (error) { thrown = { value: error }; return FAILED; }
  },
  has(object, key) {
    try { return key in object; } catch (error) { thrown = { value: error }; return FAILED; }
  },
  // `Reflect.set`, not assignment: N-API's set does not throw when the write
  // is refused (a frozen object, a non-writable property), and neither may this.
  set(object, key, value) {
    try { return reflectSet(object, key, value); } catch (error) { thrown = { value: error }; return FAILED; }
  },
  // Enumerable string keys, inherited ones included: napi_get_property_names.
  keys(object) {
    try {
      const keys = [];
      for (const key in object) keys.push(key);
      return keys;
    } catch (error) {
      thrown = { value: error };
      return FAILED;
    }
  },
  call(fn, args) {
    try { return reflectApply(fn, undefined, args); } catch (error) { thrown = { value: error }; return FAILED; }
  },
  callWith(fn, receiver, args) {
    try { return reflectApply(fn, receiver, args); } catch (error) { thrown = { value: error }; return FAILED; }
  },
  // Native: DefineHiddenProp, on an object the caller supplied.
  defineHidden(object, key, value, writable) {
    try {
      defineProperty(object, key, { value, writable, enumerable: false, configurable: false });
      return undefined;
    } catch (error) {
      thrown = { value: error };
      return FAILED;
    }
  },
  construct(ctor, args) {
    try { return reflectConstruct(ctor, args); } catch (error) { thrown = { value: error }; return FAILED; }
  },
  // The abstract ToString: throws for a Symbol, runs `toString`/`@@toPrimitive`.
  toString(value) {
    try { return `${value}`; } catch (error) { thrown = { value: error }; return FAILED; }
  },
  // Read off the global at call time and tested with the `instanceof`
  // operator, because that is what the native binding does (IsInstanceOfGlobal).
  instanceOfGlobal(value, name) {
    try {
      const ctor = globalThis[name];
      return typeof ctor === 'function' && value instanceof ctor;
    } catch (error) {
      thrown = { value: error };
      return FAILED;
    }
  },
  arrayFrom(value) {
    try { return globalThis.Array.from(value); } catch (error) { thrown = { value: error }; return FAILED; }
  },
  global(name) {
    try { return globalThis[name]; } catch (error) { thrown = { value: error }; return FAILED; }
  },
};

core.attachHost(host);

// --- LuaContext ---------------------------------------------------------------

// Every method, in the order the native binding declares them, so that the
// prototype enumerates the same way. Each is defined the way `InstanceMethod`
// defines one natively: on the prototype, and neither writable, enumerable nor
// configurable.
const CONTEXT_METHODS = [
  'execute_script',
  'execute_file',
  'set_global',
  'get_global',
  'call',
  'set_userdata',
  'set_metatable',
  'create_coroutine',
  'resume',
  'close',
  'resume_async',
  'execute_script_async',
  'execute_file_async',
  'execute_async',
  'call_async',
  'cancel',
  'is_busy',
  'add_search_path',
  'register_module',
  'compile',
  'compile_file',
  'load_bytecode',
  'create_table',
  'get_global_ref',
  'create_environment',
  'execute_script_in',
  'get_memory_usage',
  'info',
  'register_type_converter',
  'register_from_lua_converter',
  'register_class',
  'pcall',
  'set_print_handler',
  'set_read_handler',
  'set_file_reader',
  'set_hook',
  'remove_hook',
  'get_stack',
  'get_locals',
  'add_searcher',
  'release',
  'dispose',
  'reset',
  'gc',
];

// What N-API's `DefineClass` hands out, as far as a caller can tell: a
// constructor that refuses to be called without `new` in N-API's own words (a
// JavaScript class refuses in the engine's, which differ from engine to
// engine), over a prototype whose `constructor` comes after its methods. The
// class itself stays a class, for its private fields; this is its public face.
//
// `ctor` is written out as a named function at each use, not made here: the
// engine names an object after its constructor as the source spells it
// (`#<LuaContext>` in its own error messages), and a `name` property set
// afterwards does not change that.
const NO_NEW = "Class constructors cannot be invoked without 'new'";
//
// The public face is a Proxy (nativeFunction), so `ctor` is what a construction
// is made from when nothing subclasses it: the engine cannot name an object
// after a Proxy.
const nativeClass = (Impl, ctor) => {
  const proto = Impl.prototype;
  delete proto.constructor;
  ctor.prototype = proto;
  Impl.door = ctor;
  return nativeFunction(ctor);
};
const newTargetOf = (target, face, ctor) => (target === face ? ctor : target);

// A method as `InstanceMethod` makes one, with a `prototype` as every N-API
// function has.
const defineMethod = (Impl, name, method) => {
  defineProperty(method, 'name', { value: name, configurable: true });
  defineHidden(Impl.prototype, name, nativeFunction(method), false);
};

class LuaContextImpl {
  #core;
  // See "foreign exceptions". Shared with every handle this context mints.
  // `self` is weak so that a handle does not keep its context alive; `run` is
  // the promise record of an async run in flight, which C++ sets and clears.
  #state = { unwound: false, self: undefined, run: undefined };

  constructor(...args) {
    this.#state.self = new WeakRefCtor(this);
    const handle = enter(undefined, core.LuaContext, 'create', { args, state: this.#state }, LuaContextImpl.door);
    if (handle === null) throw takePending();
    this.#core = handle;
    handles.register(this, handle);
    // Native: SubscribeSharedTables, the constructor's last step. It pushes
    // each shared value through this object's own public `set_global`, so it
    // has to come after the line that makes this object a context.
    unwrap(enter(this.#state, handle, 'subscribe_shared', args, LuaContextImpl.door));
  }

  // The public constructor, which is what the caller called (nativeClass).
  static door;

  static {
    for (const name of CONTEXT_METHODS) {
      defineMethod(LuaContextImpl, name, function method(...args) {
        // What V8 says when a native method is called on the wrong receiver.
        if (typeof this !== 'object' || this === null || !(#core in this)) {
          throw makeError(TypeError, 'Illegal invocation', method);
        }
        return unwrap(enter(this.#state, this.#core, name, args, method));
      });
    }
  }
}

// --- SharedTable --------------------------------------------------------------
//
// JS-side state mirrored into several contexts. Natively it is a C++ class
// that holds one JS object and calls each subscriber's public `set_global`;
// there is no Lua in it, so here it is the same thing written directly.
// The private field is the brand: a constructor reachable from JS makes
// `instanceof` user-defeatable (native: AsSharedTable).
//
// A context subscribes through the `shared` option. The checks and the record
// a context keeps for `reset()` are in C++ (SubscribeSharedTables); the three
// functions below are what it asks of this class, which only code inside the
// class can answer.
let isSharedTable;
let subscribeShared;
let pushShared;

// Native: JsThrowMessage.
const throwMessage = (error) => {
  const message = host.errorMessage(error);
  if (message !== '') return message;
  try {
    return `${error}`;
  } catch {
    return 'JavaScript callback threw a value that could not be converted to a string';
  }
};

// Asked by each of the two doors to the constructor, which a caller cannot
// reach any other way.
const checkInitial = (args, door) => {
  const initial = args[0];
  if (initial !== undefined && initial !== null && typeof initial !== 'object') {
    throw makeError(TypeError, 'createSharedTable(initial) requires an object', door);
  }
};

class SharedTableImpl {
  #value;
  #subscribers = [];

  constructor(...args) {
    const initial = args[0];
    if (initial !== undefined && initial !== null) {
      // Held, not copied: mutating it directly and calling sync() is supported.
      this.#value = initial;
    } else {
      this.#value = {};
    }
  }

  // What V8 says when a native method is called on the wrong receiver.
  static #check(receiver, door) {
    if (typeof receiver !== 'object' || receiver === null || !(#value in receiver)) {
      throw makeError(TypeError, 'Illegal invocation', door);
    }
  }

  static #pushValue(context, name, value) {
    const setter = context.set_global;
    if (typeof setter !== 'function') {
      throw makeError(Error,
        "shared table subscriber's set_global is not a function; it has been " +
        'shadowed by an own property on the context', currentDoor ?? SharedTableImpl.#pushValue);
    }
    reflectApply(setter, context, [name, value]);
  }

  #propagate(door) {
    // Snapshot the live subscribers first, pruning collected ones: a push runs
    // user JS, which could subscribe another context while this iterates.
    const targets = [];
    this.#subscribers = this.#subscribers.filter((subscriber) => {
      const context = subscriber.context.deref();
      if (context === undefined) return false;
      targets.push({ context, name: subscriber.name });
      return true;
    });

    let failures = '';
    let failed = 0;
    for (const target of targets) {
      try {
        // Re-read per target rather than snapshotting before the loop (CR-12 F5).
        SharedTableImpl.#pushValue(target.context, target.name, this.#value);
      } catch (error) {
        // Keep going: one unavailable context must not skip the others.
        ++failed;
        if (failures !== '') failures += '; ';
        failures += `${target.name}: ${throwMessage(error)}`;
      }
    }

    if (failed > 0) {
      throw makeError(Error,
        `shared table update failed for ${failed} of ${targets.length} contexts (${failures}). ` +
        'The JS-side value was updated; call sync() to retry.', door);
    }
  }

  static {
    // Native: AsSharedTable. The private field is the brand.
    isSharedTable = (value) => typeof value === 'object' && value !== null && #value in value;
    // Native: SharedTable::Subscribe. Push before recording, so a context
    // whose first push failed is never left in the list.
    subscribeShared = (table, context, name) => {
      SharedTableImpl.#pushValue(context, name, table.#value);
      table.#subscribers.push({ context: new WeakRefCtor(context), name });
    };
    // Native: SharedTable::PushTo.
    pushShared = (table, context, name) => {
      SharedTableImpl.#pushValue(context, name, table.#value);
    };

    const methods = {
      get: function door(...args) {
        SharedTableImpl.#check(this, door);
        if (args.length < 1 || typeof args[0] !== 'string') {
          throw makeError(TypeError, 'get(key) requires a string key', door);
        }
        return this.#value[args[0]];
      },
      set: function door(...args) {
        SharedTableImpl.#check(this, door);
        if (args.length < 2 || typeof args[0] !== 'string') {
          throw makeError(TypeError, 'set(key, value) requires a string key and a value', door);
        }
        reflectSet(this.#value, args[0], args[1]);
        this.#propagate(door);  // a failed push throws after every other context is updated
        return undefined;
      },
      sync: function door() {
        SharedTableImpl.#check(this, door);
        this.#propagate(door);
        return undefined;
      },
    };
    for (const name of Object.keys(methods)) {
      defineMethod(SharedTableImpl, name, methods[name]);
    }
  }
}

const ContextFace = nativeClass(LuaContextImpl, function LuaContext(...args) {
  if (new.target === undefined) throw makeError(TypeError, NO_NEW, LuaContext);
  return reflectConstruct(LuaContextImpl, args, newTargetOf(new.target, ContextFace, LuaContext));
});
const SharedTableFace = nativeClass(SharedTableImpl, function SharedTable(...args) {
  if (new.target === undefined) throw makeError(TypeError, NO_NEW, SharedTable);
  checkInitial(args, SharedTable);
  return reflectConstruct(SharedTableImpl, args, newTargetOf(new.target, SharedTableFace, SharedTable));
});

const createSharedTable = nativeFunction(function createSharedTable(...args) {
  checkInitial(args, createSharedTable);
  return args.length > 0 ? new SharedTableFace(args[0]) : new SharedTableFace();
});

// --- calibration ----------------------------------------------------------------
//
// How much of the engine's stack one Lua C level takes, as the number of call
// arguments that take as much: what is left is measured at two depths of a
// chain that re-enters Lua through string.gsub, and the difference divided.
const argumentsLeft = () => {
  // Whole blocks first, each held by the frame of the call that follows it;
  // an engine limits the arguments of one call to well under its stack.
  const block = new Array(16384).fill(0);
  let blocks = 0;
  let rest = 0;
  const dig = () => {
    ++blocks;
    reflectApply(dig, undefined, block);
  };
  try { dig(); } catch { /* as intended */ }
  // Then, under one block fewer, what a last call can still take.
  const last = (left) => {
    if (left > 0) return reflectApply(last, undefined, [left - 1, ...block]);
    for (let bit = 8192; bit >= 16; bit >>= 1) {
      try {
        reflectApply(isArray, undefined, new Array(rest + bit).fill(0));
        rest += bit;
      } catch { /* too many */ }
    }
    return undefined;
  };
  const whole = blocks > 2 ? blocks - 2 : 0;
  try { last(whole); } catch { /* as far as it got */ }
  return whole * (block.length + 1) + rest;
};

const calibrate = () => {
  const LEVELS = 16;
  const left = [];
  const lua = new LuaContextImpl(
    { mark: () => { left.push(argumentsLeft()); } }, { libraries: ['base', 'string'] });
  lua.execute_script(`
    local function go(n)
      if n == 0 then return mark() end
      return (string.gsub("x", "x", function() go(n - 1) end))
    end
    go(1)
    go(1 + ${LEVELS})`);
  lua.dispose();
  return (left[0] - left[1]) / LEVELS;
};

// Bounded both ways, so that nothing odd about the measurement (a caller
// already deep when it imported this, an engine that moved a frame between the
// two) can make the margin useless or the module unusable.
//
// LEAST is a floor on the whole margin, and has nothing to do with Lua: V8
// compiles a function the first time it runs, on the caller's stack, and fails
// the call with the same RangeError if that does not fit. A margin of 40 KB lost
// contexts to it and one of 48 KB did not (November 25, 2026; V8 in Node 24).
const LEAST = 8192;  // 64 KB
const MOST = 1024;   // 8 KB a level
let perLevel = MOST / 2;
try { perLevel = calibrate(); } catch { /* the middle of the range */ }
const margin = Math.max(LEAST, Math.ceil(Math.min(perLevel, MOST) * FRAME_UNITS) || 0);
headroom = new Array(margin).fill(0);

export default {
  init: ContextFace,
  createSharedTable,
};
