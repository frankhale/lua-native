// Type definitions for the Lua module

/**
 * Represents a Lua table that has a metatable, returned as a JS Proxy object.
 * Property access flows through Lua metamethods (__index, __newindex, etc.).
 * When passed back to Lua, the original metatabled table is restored.
 */
export interface LuaTableRef {
  [key: string]: LuaValue;
}

/**
 * Represents a value that can be passed to or returned from Lua.
 * This includes all primitive types, arrays, objects, and functions.
 *
 * Note: Tables with metatables are returned as Proxy objects (LuaTableRef)
 * that preserve metamethods. Plain tables (no metatable) are deep-copied.
 */
export type LuaValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | LuaValue[]
  | LuaTable
  | LuaTableRef
  | LuaTableHandle
  | LuaFunction;

/**
 * A value that may be *passed into* Lua. This is wider than {@link LuaValue}
 * (what Lua hands back): the binding also converts `undefined` to nil and has
 * built-in conversions for binary data and the common JS collection types, none
 * of which Lua can produce on the way out.
 *
 * Use this for arguments; use {@link LuaValue} for results.
 *
 * @remarks
 * **What a value can lose on the way in.** The mirror of the list on
 * {@link LuaContext.execute_script}, which covers the way out. These are
 * consequences of Lua's data model rather than of this binding, and all of them
 * are silent.
 *
 * 1. **`null` and `undefined` inside an array truncate the sequence.** Both
 *    convert to Lua `nil`, and a `nil` at index *i* ends the sequence there —
 *    so `[1, null, 3, 4]` becomes a table where `#t` is `1`, `ipairs` yields one
 *    element and `table.concat` returns `"1"`. The later values are *not* lost:
 *    `t[3]` and `t[4]` still hold `3` and `4`, and `pairs` sees all three
 *    entries. It is only the sequence that is broken, which is the awkward part
 *    — nothing looks missing if you index, and almost everything is missing if
 *    you iterate. **Filter or substitute before passing an array that may
 *    contain `null`**, e.g. `rows.filter(r => r != null)`, or use `false` as a
 *    placeholder, which Lua treats as a present value.
 *
 * 2. **`null` as an object value removes the key.** `{ a: null, b: 1 }` arrives
 *    as `{ b = 1 }`. Not a `nil` value at key `a` — no key `a`.
 *
 * 3. **A circular reference is refused**, with an error naming the cycle. Lua
 *    tables cannot represent one, so there is no lossy conversion to fall back
 *    on. Nesting deeper than 100 levels is refused separately, with its own
 *    message.
 *
 * **Losses 1 and 2 can be made loud.** `strictConversion: true` at init refuses
 * them — with a message naming the index or key — instead of performing them.
 * Loss 3 already throws. See {@link LuaContextOptions.strictConversion}.
 *
 * 4. **Nothing else is lost.** Binary strings, embedded NULs, lone surrogates,
 *    negative zero, the 64-bit integer bounds, string keys that look numeric,
 *    and nested structures all cross exactly — verified by a round-trip matrix
 *    over every entry point (`tools/roundtrip-matrix/`), which also checks that all twelve
 *    entry points agree with each other.
 *
 * **Handles belong to the context that made them.** A *handle* — a table handle
 * from {@link LuaContext.get_global_ref} or {@link LuaContext.create_table}, a
 * Lua function, a coroutine, or a Lua-created userdata such as a file object —
 * is a reference into one `lua_State`. Passing one into a **different** context,
 * or back into a context that has since been {@link LuaContext.reset}, throws
 * `"... belongs to a different Lua context"`. It is refused rather than copied
 * because these objects carry a marker and no data: copying one silently
 * produced an empty table or a table of the handle's own API methods, which is
 * a plausible value and the wrong one. To move the *data*, read it out first
 * (`get_global(name)` rather than `get_global_ref(name)`).
 *
 * Two things that are deliberately **not** handles and cross freely:
 * an object registered with {@link LuaContext.set_userdata} — the binding hands
 * back the identical JS object, so it is yours and passing it anywhere copies
 * its fields like any other object — and a registered-class instance, whose
 * data crosses intact while its methods and metatable do not.
 */
export type LuaInput =
  | LuaValue
  | undefined
  | Date
  | Map<LuaInput, LuaInput>
  | Set<LuaInput>
  | ArrayBuffer
  | ArrayBufferView
  | LuaInput[]
  | { [key: string]: LuaInput };

/**
 * Represents a Lua table with string keys
 */
export interface LuaTable {
  [key: string]: LuaValue;
}

/**
 * Represents a function that can be called from Lua or returned from Lua
 */
export interface LuaFunction {
  (...args: LuaInput[]): LuaValue | LuaValue[] | void;
}

/**
 * Represents a Lua coroutine that can be resumed from JavaScript.
 *
 * A coroutine is also iterable: each `yield` is one iteration step, so
 * `for (const v of coro)` drives it to completion without a hand-written
 * `resume()` loop. A yield of several values arrives as an array, matching the
 * rest of the API. The coroutine's final `return` value arrives with
 * `done: true`, which `for..of` discards — exactly the JS generator contract.
 *
 * Iteration and `resume()` advance the same underlying Lua thread, so a loop
 * that exits early leaves the coroutine suspended where it stopped and a later
 * loop (or `resume()`) picks up from there. An already-dead coroutine yields
 * nothing rather than raising "cannot resume dead coroutine".
 *
 * `for await (const v of coro)` binds to `Symbol.asyncIterator`, which steps
 * through {@link LuaContext.resume_async} — so the coroutine may `await` a host
 * Promise at any yield. (It used to work only through JS's sync-iterable
 * fallback, which drove the *synchronous* cursor and was exactly why a yield
 * needing a Promise could not.) The two cursors are independent and both
 * advance the one Lua thread.
 *
 * @example
 * const co = lua.create_coroutine(`
 *   return function()
 *     for i = 1, 3 do coroutine.yield(i) end
 *   end
 * `);
 * for (const n of co) console.log(n);  // 1, 2, 3
 */
export interface LuaCoroutine extends Iterable<LuaValue>, AsyncIterable<LuaValue> {
  /** The current status of the coroutine */
  status: 'suspended' | 'running' | 'dead';
  /** Internal reference - do not modify */
  _coroutine: unknown;
  /**
   * Returns a fresh iteration cursor. `next(...args)` forwards its arguments as
   * the resume values, so a generator-style coroutine can be fed from JS.
   */
  [Symbol.iterator](): Iterator<LuaValue, LuaValue | undefined, LuaInput>;
  /**
   * Returns a fresh asynchronous cursor, stepping through
   * {@link LuaContext.resume_async}. Use it (via `for await`) when the
   * coroutine calls host functions that return Promises.
   */
  [Symbol.asyncIterator](): AsyncIterator<LuaValue, LuaValue | undefined, LuaInput>;
}

/**
 * Result of a protected call via `LuaContext.pcall`.
 * On success, `value` holds the function's return value (an array when the Lua
 * function returned multiple values). On failure, `error` holds the caught
 * error — the original JS Error when the failure came from a JS callback,
 * otherwise an Error carrying the Lua message and stack traceback.
 */
export type PcallResult =
  | { ok: true; value: LuaValue | LuaValue[] }
  | { ok: false; error: unknown };

/**
 * Result of resuming a coroutine
 */
export interface CoroutineResult {
  /** The status after resuming */
  status: 'suspended' | 'running' | 'dead';
  /** Values yielded or returned by the coroutine */
  values: LuaValue[];
  /** Error message if the coroutine failed */
  error?: string;
}

/**
 * Callback function that can be passed to the Lua context.
 * Receives Lua values as arguments and should return a Lua-compatible value.
 */
export interface LuaCallback {
  (...args: LuaValue[]): LuaValue | void;
}

/**
 * Object containing callbacks and values that will be available in the Lua environment
 */
export interface LuaCallbacks {
  [key: string]: LuaCallback | LuaInput;
}

/**
 * Defines a Lua metatable with metamethods and/or static values.
 * Functions become Lua C closures; other values are set directly.
 */
export interface MetatableDefinition {
  /**
   * Any Lua metamethod name, or a plain value to place on the metatable.
   *
   * The commonly used ones are `__index`, `__newindex`, `__call`, `__tostring`,
   * the arithmetic and comparison metamethods (`__add`, `__eq`, `__lt`, …),
   * `__len`, `__gc`, and **`__close`** — a to-be-closed variable
   * (`local x <close> = obj`) runs it on scope exit, and it works both in pure
   * Lua and when installed from here. `__close` is called out because it is
   * easy to assume Lua 5.4+ scoping features stop at the binding; it does not.
   */
  [key: string]: LuaCallback | LuaInput;
}

/**
 * What Lua calls a chunk in an error message or traceback.
 *
 * Without one, a chunk loaded from a string is named after the source itself,
 * so an error reads `[string "local x = nil..."]:2:` — which identifies nothing
 * when the source came from a file, a database row, or a user.
 *
 * **Lua's prefix conventions apply, and they are the whole of the formatting
 * story:**
 *
 * | `chunkName` | Error reads |
 * |---|---|
 * | *(omitted)* | `[string "local x = nil..."]:2:` |
 * | `'config.lua'` | `[string "config.lua"]:2:` |
 * | `'@config.lua'` | `config.lua:2:` — `@` means "this is a file" |
 * | `'=config'` | `config:2:` — `=` means "print verbatim" |
 *
 * `@` is almost always the one you want: it is what `execute_file` and
 * `compile_file` use, so a named string chunk reports like a real file.
 *
 * A non-string value is **rejected**, not ignored — an option whose purpose is
 * legible errors would otherwise fail silently and hand back the default name.
 */
/**
 * One frame of the Lua call stack, as {@link LuaContext.get_stack} reports it.
 * The fields are Lua's own (`lua_getinfo` with `"nSl"`), renamed to JS casing.
 */
export interface LuaStackFrame {
  /** 0 is the innermost frame. */
  level: number;
  /** The chunk as Lua records it: `@file`, `=name`, or the source text. */
  source: string;
  /** What an error message would print for this chunk. */
  shortSource: string;
  /** Current line, or -1 where Lua has no line information (a C frame). */
  currentLine: number;
  /** Line where the function was defined, or -1. */
  lineDefined: number;
  /** The function's name if Lua can infer one from the call site, else `''`. */
  name: string;
  /** How the name was found: `'global'`, `'local'`, `'method'`, `'field'`, or `''`. */
  nameWhat: string;
  /** `'Lua'`, `'C'`, or `'main'`. */
  what: string;
}

export interface ChunkNameOptions {
  /** Name for this chunk in errors and tracebacks. See {@link ChunkNameOptions}. */
  chunkName?: string;
}

/**
 * Options for bytecode compilation
 */
export interface CompileOptions extends ChunkNameOptions {
  /** Strip debug info (line numbers, local variable names) for smaller bytecode. Default: false */
  stripDebug?: boolean;
}

/**
 * A method function registered on userdata.
 * The first argument is always the JS object (`self`), passed automatically
 * when Lua calls `obj:method(args)`.
 * Remaining arguments come from the Lua call.
 */
export interface UserdataMethod {
  (self: any, ...args: LuaInput[]): LuaValue | LuaValue[] | void;
}

/**
 * Options for set_userdata controlling property access and methods from Lua
 */
export interface UserdataOptions {
  /** Allow Lua to read properties via __index */
  readable?: boolean;
  /** Allow Lua to write properties via __newindex */
  writable?: boolean;
  /**
   * Methods callable from Lua via `obj:method()` syntax.
   * Each method receives the original JS object as the first argument (`self`).
   *
   * Methods take precedence over properties when names collide.
   * Methods work independently of `readable`/`writable` — an opaque handle
   * can have methods even if its properties are hidden.
   *
   * @example
   * lua.set_userdata('player', playerObj, {
   *   readable: true,
   *   methods: {
   *     move: (self, dx, dy) => { self.x += dx; self.y += dy; },
   *     get_pos: (self) => [self.x, self.y],
   *   }
   * });
   * // Lua: player:move(10, 20)
   */
  methods?: Record<string, UserdataMethod>;
}

/**
 * Defines a JavaScript class/usertype registered with `register_class()`.
 * Lua can construct instances via `ClassName.new(...)`, call methods with
 * `instance:method()`, access properties, and use overloaded operators.
 */
export interface ClassDefinition {
  /**
   * Constructor invoked when Lua calls `ClassName.new(...)`. Receives the Lua
   * call arguments and must return the instance object. Lua holds the returned
   * object by reference (as userdata), not a copy.
   */
  construct: (...args: LuaValue[]) => object;

  /**
   * Name of a class registered earlier on this context to inherit from.
   *
   * A method missing from this class is looked up along the base chain, and the
   * base's metamethods (`__add`, `__tostring`, …) apply to instances of this
   * class unless it defines its own. `readable` / `writable` are per-instance
   * and set by the constructor, so they are not inherited — state them here too
   * if this class needs them.
   *
   * Each class still supplies its own `construct`: the JS class hierarchy is
   * what decides how an instance is built, and `extends` only describes how Lua
   * resolves names on it.
   *
   * @example
   * lua.register_class('Animal', {
   *   construct: (name) => new Animal(name),
   *   readable: true,
   *   methods: { describe: (self) => `a ${self.species}` },
   * });
   * lua.register_class('Dog', {
   *   extends: 'Animal',
   *   construct: (name) => new Dog(name),
   *   readable: true,
   *   methods: { speak: () => 'woof' },
   * });
   * // Lua: local d = Dog.new('rex'); d:speak(); d:describe()
   */
  extends?: string;

  /**
   * Instance methods callable from Lua via `instance:method(args)`. Each method
   * receives the instance object as the first argument (`self`).
   */
  methods?: Record<string, UserdataMethod>;

  /**
   * Metamethods for the class — operator overloads and hooks such as `__add`,
   * `__eq`, `__lt`, `__le`, `__len`, `__concat`, `__unm`, `__tostring`, and
   * `__call`. Each receives its Lua operands (instances arrive as their JS
   * objects) and returns the result.
   */
  metamethods?: Record<string, LuaCallback>;

  /**
   * Named property accessors — the fine-grained counterpart to
   * `readable`/`writable`, and the way to express a computed property, a
   * validated setter, or a read-only field on an otherwise writable instance.
   *
   * Each entry may supply `get`, `set`, or both. Reading a set-only property
   * and writing a get-only one are both refused with a message naming the class,
   * rather than silently answering `nil` or doing nothing.
   *
   * **Precedence: methods, then accessors, then `readable`/`writable`.** An
   * accessor is consulted before the blanket flags and wins over them, so a
   * class with `readable: false` and one accessor exposes exactly that one
   * property. A method of the same name still shadows the accessor.
   *
   * **Accessors are inherited** along the `extends` chain, unlike
   * `readable`/`writable` and unlike {@link ClassDefinition.statics}. The rule
   * is the one `extends` already states: it governs how Lua resolves names *on
   * an instance*, which is exactly what an accessor does.
   *
   * @example
   * lua.register_class('Player', {
   *   construct: (name: string) => new Player(name),
   *   properties: {
   *     health: {
   *       get: (self) => self._hp,
   *       set: (self, v) => { if (v < 0) throw new Error('hp must be >= 0'); self._hp = v; },
   *     },
   *     name: { get: (self) => self._name },   // read-only from Lua
   *   },
   * });
   * // Lua: p.health = 10   -> the setter runs
   * //      p.name = "x"    -> error: property 'name' of class 'Player' is read-only
   */
  properties?: Record<string, {
    get?: (self: any) => LuaValue | LuaValue[] | void;
    set?: (self: any, value: LuaValue) => void;
  }>;

  /**
   * Class-level members, placed on the class *table* rather than on instances —
   * `ClassName.count`, `ClassName.from_json(...)`.
   *
   * Functions become callable from Lua as `ClassName.fn(...)` and receive the
   * Lua call arguments with no `self`. Other values are converted **once, at
   * registration**, and set directly: a static is a class-level constant, not a
   * live view of the JavaScript property.
   *
   * `new` is reserved (it is the constructor) and is rejected.
   *
   * **Statics are not inherited.** `extends` describes how Lua resolves names on
   * an *instance*; the class table has no metatable and therefore no lookup
   * chain to extend. A derived class that wants a base's static states it again.
   *
   * @example
   * lua.register_class('Player', {
   *   construct: (name: string) => new Player(name),
   *   statics: { count: () => Player.instances, VERSION: '1.2.0' },
   * });
   * // Lua: Player.count()   Player.VERSION
   */
  statics?: Record<string, LuaCallback | LuaInput>;

  /**
   * Allow Lua to read instance properties via `instance.prop` (default: false).
   * Blanket access; see {@link ClassDefinition.properties} for per-name control,
   * which is consulted first.
   */
  readable?: boolean;

  /**
   * Allow Lua to write instance properties via `instance.prop = v`
   * (default: false). See {@link ClassDefinition.properties}.
   */
  writable?: boolean;
}

/**
 * A handle to a Lua table stored in the Lua registry.
 * Provides direct get/set/iterate access without execute_script.
 *
 * The handle holds a live reference — mutations from JS are visible
 * in Lua and vice versa. Call release() when done to free the
 * registry slot.
 */
export interface LuaTableHandle {
  /**
   * Get a field by key. Triggers __index if the table has a metatable.
   *
   * The key's JS type selects the Lua key type: a `number` addresses an
   * integer key when integral (e.g. `1`) or a float key otherwise (e.g. `1.5`),
   * while a `string` always addresses a string key — never coerced. This makes
   * a genuine string key like `"123"` distinct from integer key `123`
   * (`t.get("123")` vs `t.get(123)`), unlike Proxy-based access where JS
   * property keys are always strings.
   *
   * A `boolean` addresses a genuine boolean key — `t[true]`, which Lua allows
   * and which is distinct from integer key `1`. This is the key type
   * {@link pairs} emits and every accessor here accepts; a table, function or
   * userdata key can be neither passed nor read back, and {@link pairs} skips
   * those rather than emitting an entry nothing could address.
   */
  get(key: string | number | boolean): LuaValue;

  /**
   * Get a nested table field as a live handle rather than a copy.
   *
   * `get()` follows the library's usual conversion rule: a Lua table **without**
   * a metatable comes back as a detached deep copy, so mutating it does nothing
   * to Lua and `set_metatable()` has nothing to attach to. `get_ref()` is the
   * explicit opt-in to the real table — `get_global_ref()` one level down.
   *
   * Handles compose, so any depth is reachable, and because the key keeps its JS
   * type (see {@link get}) an integer key and array element are addressable too
   * — neither of which a dotted string path could express.
   *
   * The read triggers `__index` like `get()`. The returned handle is independent
   * of the one it came from: it stays valid after the parent is released, and
   * needs its own `release()`.
   *
   * @param key The field to reference
   * @returns A handle to the table stored at `key`
   * @throws If the field is not a table (including nil), or this handle has been
   *   released
   * @example
   * lua.execute_script('config = { db = { host = "localhost" } }');
   *
   * const db = lua.get_global_ref('config').get_ref('db');
   * db.set('port', 5432);                       // reaches the real Lua table
   * lua.set_metatable(db, { __index: () => null });
   * db.release();
   */
  get_ref(key: string | number | boolean): LuaTableHandle;

  /** Set a field by key. Triggers __newindex if the table has a metatable. See {@link get} for how the key's JS type maps to the Lua key type. */
  set(key: string | number | boolean, value: LuaInput): void;

  /** Check if a key exists in the table. See {@link get} for how the key's JS type maps to the Lua key type. */
  has(key: string | number | boolean): boolean;

  /** Get the table length (# operator). Triggers __len metamethod. */
  length(): number;

  /**
   * Get the table's key-value pairs (like Lua `pairs()`), as an array of
   * `[key, value]` tuples.
   *
   * **Which keys are emitted, stated exactly** — this is the escape hatch
   * `LIMITATIONS.md` §5 points at for keys a plain converted object cannot
   * hold, so its own edges matter:
   *
   * - `string`, `number` and `boolean` keys are emitted. A boolean key is a
   *   real Lua key (`t[true]`) and stays distinct from integer key `1`.
   * - Under {@link LuaInitOptions.binaryStrings} a string key arrives as a
   *   `Uint8Array` of its exact bytes — the mode's whole point, and the reason
   *   this is the remedy for a key whose bytes are not valid UTF-8. Without the
   *   option a key is decoded as text, so a non-UTF-8 key is mangled here just
   *   as it would be as a property name (§5).
   * - **A table, function, userdata or thread key is skipped.** None can be
   *   passed to {@link get}/{@link set}/{@link has}, so emitting one would
   *   produce an entry the caller could see and never address. The omission is
   *   deliberate and is the one loss this method still has.
   *
   * Unlike a converted object, a number key and a string key with the same text
   * do **not** collide here — each is its own tuple.
   *
   * The traversal is a snapshot taken under protection, not a live cursor: it
   * fires no metamethod (`lua_next` is raw), and a `__gc` finalizer running
   * mid-conversion cannot corrupt it.
   */
  pairs(): Array<[string | number | boolean | Uint8Array, LuaValue]>;

  /**
   * Get integer-keyed sequence entries (like Lua ipairs()).
   * Iterates from index 1 until the first nil value.
   * Returns an array of [index, value] tuples.
   */
  ipairs(): Array<[number, LuaValue]>;

  /**
   * The table's keys, without converting a single value.
   *
   * Same key rule as {@link pairs} — string, number and boolean keys, as
   * `Uint8Array` under `binaryStrings`, with table/function/userdata keys
   * skipped. Use it when you want to know what is in a table without paying to
   * marshal what it holds.
   */
  keys(): Array<string | number | boolean | Uint8Array>;

  /**
   * Iterate the table lazily: `for (const [key, value] of handle)`.
   *
   * Yields the same entries as {@link pairs}, in the same order, but converts
   * each value **as you reach it** rather than all of them up front — so
   * stopping early costs only what you consumed. Measured on a 200-entry table
   * of tables: `pairs()` runs 200 value conversions, a loop that `break`s after
   * one runs one.
   *
   * **What is snapshotted and what is live.** The *key set* is captured when
   * iteration begins; the *values* are read as you advance. That split is not a
   * convenience — a cursor left open across a return into JavaScript would make
   * any mutation of the table mid-loop undefined behaviour in Lua's traversal,
   * and JS runs between every two steps. The consequences are worth knowing:
   *
   * - A key added after iteration begins is not visited.
   * - A key deleted before its turn is skipped rather than yielded as nil.
   * - A value replaced before its turn yields the new value.
   * - Reads are **raw**, exactly as `pairs()` is: `__index` is never consulted.
   *
   * Each call mints an independent cursor, so two loops over one handle do not
   * interfere. Releasing the handle mid-loop ends the iteration; a `reset()`
   * mid-loop makes the next step throw rather than read the retired state.
   *
   * @example
   * for (const [key, value] of lua.get_global_ref('config')) {
   *   console.log(key, value);
   * }
   */
  [Symbol.iterator](): IterableIterator<[string | number | boolean | Uint8Array, LuaValue]>;

  /**
   * Release the registry reference. After calling release(),
   * all other methods throw. Safe to call multiple times.
   */
  release(): void;
}

/**
 * The kind of event a {@link LuaHookCallback} was fired for.
 *
 * - `'call'` — a function was entered
 * - `'tail call'` — a function was entered by a tail call (`return f()`);
 *   Lua reports these separately and no matching `'return'` event follows
 * - `'return'` — a function returned
 * - `'line'` — a new source line is about to execute
 * - `'count'` — the requested number of VM instructions has elapsed
 */
export type LuaHookEvent = 'call' | 'tail call' | 'return' | 'line' | 'count';

/**
 * Receives one debug-hook event.
 *
 * @param event What happened — see {@link LuaHookEvent}
 * @param line The current source line, or `-1` where Lua has no line
 *   information (a C function, or a stripped chunk)
 * @param name The function's name if Lua can determine one, otherwise `''`.
 *   Lua infers names from the call site, so an anonymous function, a tail call,
 *   or a main chunk usually reports `''`.
 */
export type LuaHookCallback = (
  event: LuaHookEvent,
  line: number,
  name: string
) => void;

/**
 * Which events a debug hook fires on. At least one must be requested.
 */
export interface HookOptions {
  /** Fire on function entry (`'call'` and `'tail call'` events). */
  call?: boolean;

  /** Fire on function return (`'return'` events). */
  return?: boolean;

  /** Fire on each new source line (`'line'` events). The most expensive option. */
  line?: boolean;

  /**
   * Fire a `'count'` event every N Lua VM instructions. Must be a positive
   * integer.
   *
   * When `maxInstructions` is also set, both share one underlying hook: the
   * finer interval is installed and each is tallied to its own granularity, so
   * the event still arrives every N instructions as requested.
   */
  count?: number;
}

/**
 * A diagnostics snapshot of a Lua context, returned by
 * {@link LuaContext.info}.
 */
export interface LuaStateInfo {
  /** Lua version of the linked build, e.g. `'Lua 5.5'`. */
  version: string;

  /** Full version including the patch level, e.g. `'Lua 5.5.0'`. */
  release: string;

  /** Numeric version for comparisons: major * 100 + minor (e.g. `505`). */
  versionNumber: number;

  /** Memory currently held by the Lua state, in bytes. Same value as `get_memory_usage()`. */
  memoryBytes: number;

  /** Memory currently held by the Lua state, in kilobytes (fractional). */
  memoryKB: number;

  /** The `maxMemory` this context was created with, in bytes. `0` means unlimited. */
  memoryLimit: number;

  /** The `maxInstructions` limit in force. `0` means unlimited. */
  maxInstructions: number;

  /** The `timeout` in force, in milliseconds. `0` means no timeout. */
  timeout: number;

  /**
   * Standard libraries loaded into this state, by name. A preset reads back as
   * the names it expanded to (`'all'` → all ten), and a bare state as `[]`.
   */
  libraries: LuaLibrary[];

  /**
   * How many JS values this context's own bookkeeping is holding alive, by
   * container. Diagnostic only — nothing in the binding reads these back, and
   * no behaviour depends on them.
   *
   * `memoryBytes` above measures the *Lua* heap. This measures the other side:
   * the callbacks, userdata wrappers, converters and handlers the addon retains
   * on the JS side so Lua can reach them. A context that grows without bound
   * while `memoryBytes` stays flat is leaking here.
   */
  bindingRefs: BindingRefCounts;
}

/**
 * Per-container counts of the JS values a context retains, from
 * {@link LuaStateInfo.bindingRefs}.
 *
 * Each number counts **entries**, not `Napi::Reference`s — a class property
 * with both a getter and a setter is one entry. `total` is the sum of the
 * others, computed natively so the parts and the whole cannot disagree.
 *
 * These are diagnostics, not a contract: the set of containers reflects how the
 * binding is currently built and may change with it. What is stable is the
 * intent — a count that grows across repeated create/use/discard cycles is a
 * leak, and that is what `tools/binding-balance` checks.
 */
export interface BindingRefCounts {
  /** Host functions registered for Lua to call, by name. */
  callbacks: number;
  /** Live userdata instances, including `register_class` ones. */
  userdata: number;
  /** Userdata whose method closures are still registered. */
  userdataMethods: number;
  /** Thrown JS errors staged for round-trip; cleared at each outermost call. */
  errorRegistry: number;
  /** Classes registered via `register_class`. Permanent by design. */
  classes: number;
  /** Named class properties with an accessor. Permanent by design. */
  classAccessors: number;
  /** Converters registered with `register_type_converter`. */
  typeConverters: number;
  /** Converters registered with `register_from_lua_converter`. */
  fromLuaConverters: number;
  /** JS `require` searchers added with `add_searcher`. */
  searchers: number;
  /** Shared tables this context is subscribed to. */
  sharedTables: number;
  /** Redirection handlers in force: print, read, file reader, debug hook (0–4). */
  handlers: number;
  /** References held only while an async run is in flight (0–3 at rest: 0). */
  asyncRefs: number;
  /** Whether a `callbacks` object is registered (0 or 1). */
  callbacksObject: number;
  /** Sum of every count above. */
  total: number;
}

/**
 * An environment table: a private global namespace for scripts run with
 * {@link LuaContext.execute_script_in}.
 *
 * It is an ordinary table reference, so the full handle surface applies —
 * `get`/`set` to seed helpers or read back what a script defined, `pairs()` to
 * inspect it, `release()` when done.
 */
export interface LuaEnvironment extends LuaTableHandle {}

/**
 * Options for {@link LuaContext.create_environment}.
 */
export interface EnvironmentOptions {
  /**
   * Global names to seed the environment with, copied from `_G` by value
   * (e.g. `['math', 'print']`). A name that is unset in `_G` is skipped.
   * Default: none — an empty environment.
   */
  whitelist?: string[];

  /**
   * Fall back to the real globals for names the environment doesn't define,
   * via an `__index` metatable pointing at `_G`. Reads fall through; writes
   * never do, so an assignment shadows the global instead of overwriting it.
   * Default: false.
   */
  inherit?: boolean;
}

/**
 * Represents a Lua execution context
 */
export interface LuaContext {
  /**
   * Executes a Lua script string and returns the result.
   * Use the generic parameter to specify the expected return type.
   * @param script The Lua script to execute
   * @returns The result of the script execution
   * @example
   * const num = lua.execute_script<number>('return 42');
   * const fn = lua.execute_script<LuaFunction>('return function(x) return x * 2 end');
   *
   * @remarks
   * **Three things a value can lose on the way from Lua to JavaScript.** All
   * three are consequences of the JavaScript type system rather than of this
   * binding, all three are silent, and all three were found by differential
   * testing against stock Lua (`tools/diff-oracle/`). They are listed here
   * because a silent loss you know about is a constraint and a silent loss you
   * do not is a bug in your program.
   *
   * 1. **A Lua string that is not valid UTF-8 is mangled.** Lua strings are
   *    byte strings and JavaScript strings are UTF-16; every invalid byte
   *    becomes U+FFFD (the replacement character). The loss is not recoverable
   *    and not idempotent — a 4-byte blob `"\x00\x01\xFE\xFF"` round-tripped
   *    through JavaScript comes back into Lua as **8** bytes, and comparing it
   *    to the original is false. It is also data-dependent, which is the
   *    dangerous part: `string.pack('i4', 7)` is all bytes below 0x80 and
   *    survives intact, so binary handling can appear to work for a long time.
   *    **To move binary data, encode it** — base64 or hex through the boundary,
   *    or keep it in Lua behind a `LuaTableHandle` and never read it out.
   *
   * 2. **Table keys that are not strings or numbers are dropped.**
   *    `{[true] = 1, [false] = 2}` arrives as `{}`. Not null values — absent
   *    entries. Boolean, table and function keys have no JavaScript object-key
   *    equivalent.
   *
   * 3. **A string key and a number key with the same text collide.**
   *    `{["1"] = "strkey", [1] = "intkey"}` is two distinct entries in Lua and
   *    arrives as a single JavaScript property `"1"`; one value is lost, and
   *    which one depends on table order. JavaScript object keys are strings.
   *
   * None of this applies to values kept on the Lua side: a `LuaTableHandle`
   * from {@link get_global_ref} reads the real table in place, so binary
   * strings, boolean keys and colliding keys all stay intact as long as you do
   * not marshal them out.
   *
   * **Two of the three can be made loud.** `strictConversion: true` at init
   * refuses losses 2 and 3 — naming the key type, or the property the two keys
   * collide on — instead of performing them; `binaryStrings: true` fixes loss 1
   * by handing back the exact bytes. See
   * {@link LuaContextOptions.strictConversion} and
   * {@link LuaContextOptions.binaryStrings}.
   *
   * **A note on integer width, which changes a type rather than losing data.**
   * A Lua integer outside ±(2^53 − 1) arrives as a **BigInt**, because a JS
   * `number` cannot hold it exactly. So `typeof` is not stable across a round
   * trip at the boundary: `set_global('n', 2 ** 53)` reads back as
   * `9007199254740992n`, a BigInt, not a number. Values inside the safe range
   * are unaffected.
   *
   * **Naming the chunk.** Pass `{ chunkName: '@name.lua' }` to control how this
   * script is identified in errors and tracebacks — without it an error names
   * the source itself (`[string "local x = nil..."]:2:`), which identifies
   * nothing when the script came from a file or a user. Every door that loads
   * Lua source takes the same option; see {@link ChunkNameOptions}.
   *
   * @example
   * lua.execute_script(src, { chunkName: `@${path}` });
   * // an error now reads:  scripts/init.lua:12: attempt to index a nil value
   */
  execute_script<T extends LuaValue | LuaValue[] = LuaValue>(
    script: string,
    options?: ChunkNameOptions
  ): T;

  /**
   * Executes a Lua file and returns the result.
   * Use the generic parameter to specify the expected return type.
   * @param filepath The path to the Lua file to execute
   * @returns The result of the file execution
   * @example
   * const result = lua.execute_file<number>('./scripts/init.lua');
   */
  execute_file<T extends LuaValue | LuaValue[] = LuaValue>(filepath: string): T;

  /**
   * Sets a global variable or function in the Lua environment.
   *
   * A dotted `name` addresses a nested field: `set_global('config.db.host', v)`
   * assigns `config.db.host = v`, creating any missing intermediate tables
   * (`config` and `config.db`) as it descends. Field access flows through
   * `__index`/`__newindex` metamethods, like real Lua field access. It throws
   * if an existing intermediate is a non-table value (e.g. `config` is a
   * number), or if the path is malformed (a leading, trailing, or doubled dot).
   * A name with no dot sets a single global whose key may itself contain dots.
   *
   * **Cross-context values.** A table handle, environment, coroutine or Lua
   * function belonging to a *different* context is rejected — its registry
   * index addresses an unrelated state. To copy data between contexts, read it
   * by value first: `b.set_global('cfg', a.get_global('cfg'))` works, whereas
   * passing `a.get_global_ref('cfg')` throws "table handle belongs to a
   * different Lua context". Plain objects, including registered class instances
   * and JS-created userdata, are deep-copied across as ordinary data.
   *
   * @param name The name of the global variable, or a dotted path to a nested field
   * @param value The value to set (function, number, boolean, string, or object)
   */
  set_global(name: string, value: LuaInput | LuaCallback): void;

  /**
   * Gets a global variable from the Lua environment.
   *
   * A dotted `name` reads a nested field: `get_global('config.db.host')`
   * returns `config.db.host`, descending through `__index` metamethods. If any
   * segment along the path is nil, the result is `null` (optional-chaining
   * semantics), just as a missing single global reads back as `null`. It throws
   * only if a non-nil intermediate is a non-indexable value (e.g. `config.db`
   * is a number) or if the path is malformed.
   *
   * @param name The name of the global variable, or a dotted path to a nested field
   * @returns The value of the global, or null if not set
   */
  get_global(name: string): LuaValue;

  /**
   * Calls a Lua function by global name, returning its result (an array when
   * the function returned several values, `undefined` when it returned none).
   *
   * Convenience over `get_global(name)` followed by calling the returned
   * wrapper — but it never mints that wrapper, so a hot call loop doesn't leave
   * a JS function object and its Lua registry slot behind on each iteration.
   *
   * `name` accepts a dotted path, like `get_global`. The target must be a Lua
   * function; a callable table (one with `__call`) is not accepted here — reach
   * it through `get_global` instead. A Lua error propagates as a thrown JS
   * error, with the original `Error` preserved when the failure came from a JS
   * callback.
   *
   * @param name The global name of a Lua function, or a dotted path to one
   * @param args Arguments to pass to the function
   * @example
   * lua.execute_script('function greet(name) return "hello " .. name end');
   * lua.call('greet', 'world');  // 'hello world'
   *
   * lua.execute_script('handlers = { onTick = function(n) return n * 2 end }');
   * lua.call('handlers.onTick', 21);  // 42
   */
  call<T extends LuaValue | LuaValue[] = LuaValue>(name: string, ...args: LuaInput[]): T;

  /**
   * Sets a JavaScript object as userdata in the Lua environment.
   * The object is passed by reference - Lua holds a handle to the original object,
   * not a copy. When the userdata flows back to JS (via callbacks or return values),
   * the original object is returned.
   *
   * @param name The global variable name in Lua
   * @param value The JavaScript object to store as userdata
   * @param options Optional access control for property access from Lua
   * @example
   * // Opaque handle (Lua can pass it around but not inspect it)
   * lua.set_userdata('handle', myObject);
   *
   * // With property access (Lua can read/write properties)
   * lua.set_userdata('player', playerObj, { readable: true, writable: true });
   *
   * // Read-only (Lua can read but not write)
   * lua.set_userdata('config', configObj, { readable: true });
   */
  set_userdata(name: string, value: object, options?: UserdataOptions): void;

  /**
   * Sets a metatable on a Lua table, enabling operator overloading, custom
   * indexing, __tostring, __call, and other metamethods.
   *
   * The target is either the name of an existing global table, or a live table
   * reference — a `create_table()` / `get_global_ref()` / `create_environment()`
   * handle, or the Proxy a metatabled table round-trips as. The table need not
   * have a global name.
   *
   * Any metatable the table already had is replaced, matching Lua's
   * `setmetatable`. A handle from another context, or one that has been
   * released, is rejected.
   *
   * @param target The name of an existing global table, or a table reference
   * @param metatable An object whose keys are metamethod names (e.g. __add, __tostring)
   *   and values are either callback functions or static Lua values
   * @example
   * lua.execute_script('vec = {x = 1, y = 2}');
   * lua.set_metatable('vec', {
   *   __tostring: (t) => `(${t.x}, ${t.y})`,
   *   __add: (a, b) => { ... }
   * });
   *
   * // On a table that has no global name:
   * const defaults = lua.create_table();
   * lua.set_metatable(defaults, { __index: (t, k) => `<${k}>` });
   * defaults.get('missing');  // '<missing>'
   */
  set_metatable(
    target: string | LuaTableHandle | LuaTableRef,
    metatable: MetatableDefinition
  ): void;

  /**
   * Appends a search path to Lua's `package.path` for module resolution.
   * The path must contain a `?` placeholder that gets replaced by the module name.
   * Requires the `package` library to be loaded.
   *
   * @param path Search path template (e.g., './modules/?.lua')
   * @example
   * lua.add_search_path('./lua_modules/?.lua');
   * lua.add_search_path('./libs/?/init.lua');
   * // Lua: local mod = require('mymod')  -- searches ./lua_modules/mymod.lua
   */
  add_search_path(path: string): void;

  /**
   * Registers a JavaScript object as a Lua module, making it available via `require(name)`.
   * The module is pre-loaded into `package.loaded` — no filesystem search occurs.
   * Functions in the module object become callable from Lua.
   * Requires the `package` library to be loaded.
   *
   * @param name The module name used in `require(name)`
   * @param module An object whose properties become the module's fields
   * @example
   * lua.register_module('utils', {
   *   clamp: (x, min, max) => Math.min(Math.max(x, min), max),
   *   version: '1.0.0',
   * });
   * // Lua: local utils = require('utils'); utils.clamp(5, 0, 10)
   */
  register_module(name: string, module: LuaTable | LuaCallbacks): void;

  /**
   * Creates a coroutine from a Lua script that returns a function, or from a
   * Lua function already held on the JS side.
   *
   * The function form takes any `LuaFunction` this context produced — from
   * `execute_script`, `get_global`, a callback argument — so a function you
   * already have need not be re-sourced as text. A plain JavaScript function is
   * rejected: a coroutine body has to be a Lua function. A function belonging to
   * another context, or one passed to `release()`, is rejected too.
   *
   * The returned coroutine is iterable — see {@link LuaCoroutine}.
   *
   * Takes `{ chunkName }` like {@link execute_script} — see {@link ChunkNameOptions}.
   *
   * @param body A Lua script that returns a function, or a Lua function
   * @returns A coroutine object that can be resumed or iterated
   * @example
   * const coro = lua.create_coroutine(`
   *   return function(x)
   *     coroutine.yield(x * 2)
   *     coroutine.yield(x * 3)
   *     return x * 4
   *   end
   * `);
   *
   * // From a function you already hold:
   * const fn = lua.get_global('producer') as LuaFunction;
   * for (const item of lua.create_coroutine(fn)) console.log(item);
   */
  create_coroutine(body: string | LuaFunction, options?: ChunkNameOptions): LuaCoroutine;

  /**
   * Resumes a suspended coroutine with optional arguments.
   * @param coroutine The coroutine to resume
   * @param args Arguments to pass to the coroutine (received by yield on resume, or as function args on first resume)
   * @returns The result containing status and yielded/returned values
   * @example
   * const result = lua.resume(coro, 10);
   * // result.status: 'suspended' | 'dead'
   * // result.values: yielded or returned values
   */
  resume(coroutine: LuaCoroutine, ...args: LuaInput[]): CoroutineResult;

  /**
   * Resumes a coroutine **asynchronously**, so it may `await` a host Promise.
   *
   * The awaiting counterpart to {@link resume}, and a drop-in for it: the
   * resolved value is the same `{ status, values, error? }` object, including
   * for a Lua error, which is reported in the result rather than thrown.
   *
   * A coroutine driven by {@link resume} runs synchronously, so a JS callback
   * that returns a Promise anywhere inside it hard-errors. Under `resume_async`
   * the coroutine *is* the driven thread, so such a call suspends it until the
   * Promise settles and then continues. A coroutine created *inside* it still
   * cannot await and says so.
   *
   * Only one asynchronous operation runs per context at a time; a second call
   * while one is in flight throws "Lua context is busy with an async operation".
   *
   * {@link cancel} abandons the run and rejects the Promise, and — because the
   * coroutine is yours, not the binding's — leaves it **suspended and
   * resumable** at the point it reached, exactly as breaking out of a
   * `for await` loop does.
   *
   * @param coroutine The coroutine to resume
   * @param args Arguments passed to the coroutine (received by `yield`, or as
   *   the function's arguments on the first resume)
   * @example
   * const co = lua.create_coroutine(`
   *   return function(id)
   *     local user = fetchUser(id)   -- a JS callback returning a Promise
   *     coroutine.yield(user.name)
   *   end
   * `);
   * const step = await lua.resume_async(co, 7);
   * // step.status === 'suspended', step.values === ['Ada']
   */
  resume_async(coroutine: LuaCoroutine, ...args: LuaInput[]): Promise<CoroutineResult>;

  /**
   * Closes a coroutine: runs its pending to-be-closed variables
   * (`local x <close> = …`) and marks the thread dead. Mirrors Lua's own
   * `coroutine.close`.
   *
   * **This is the only way to run those handlers from JavaScript.**
   * {@link release} frees the coroutine's registry slot without executing
   * anything, and garbage collection runs `__gc` but not `__close`. Because
   * breaking out of a `for..of` (or `for await`) loop deliberately leaves the
   * coroutine suspended, producing an unclosed thread is an ordinary outcome of
   * the documented API rather than an edge case — so closing is worth doing
   * whenever a coroutine you abandoned might hold a resource.
   *
   * Idempotent: closing an already-closed, finished, or released coroutine
   * succeeds and does nothing. Throws if a `__close` handler raises — the
   * thread is dead either way, since a failed close still closed everything it
   * reached before failing.
   *
   * **{@link release} deliberately does not close.** Folding a close into it
   * would make a "free this slot" call run arbitrary Lua — and from there
   * JavaScript — re-entrantly, and give it a way to throw; `release` is called
   * from teardown paths where neither is acceptable. The two are orthogonal, as
   * `coroutine.close` and letting a thread be collected are in Lua.
   *
   * @param coroutine The coroutine to close
   * @example
   * const co = lua.create_coroutine(`
   *   return function()
   *     local f <close> = openResource()
   *     for i = 1, 100 do coroutine.yield(i) end
   *   end
   * `);
   * for (const n of co) { if (n === 3) break; }   // suspended, f still open
   * lua.close(co);                                 // __close runs now
   */
  close(coroutine: LuaCoroutine): void;

  /**
   * Executes a Lua script string asynchronously on a worker thread.
   * Returns a Promise that resolves with the result.
   * JS callbacks are not available during async execution.
   *
   * **Throws (synchronously, before any Promise exists) if this thread is
   * already inside the Lua state.** Running on a worker thread means handing
   * the `lua_State` to that thread, and a Lua state may only be touched by one
   * thread at a time — so three of the four conditions that make {@link reset}
   * refuse apply here, for the same reason and with the same wording, plus a
   * trailing clause naming the worker handoff. Conditions 2 and 3 name the
   * method; condition 1 is the shared "Lua context is busy with an async
   * operation" message that every synchronous method emits, so match on the
   * reason rather than on the method name if you are branching on it:
   *
   * 1. *Another async operation is in flight* (`is_busy()` is true).
   * 2. *Lua is executing on this thread* — you called this from a host
   *    callback, a metamethod, or a `__gc` finalizer. The worker would parse
   *    and run on the very state the frame below you is executing in.
   * 3. *Another lua-native call is on the stack, running your JavaScript* — a
   *    registered type converter, a definition-object getter, or a `Proxy`
   *    trap, which will return into native code that still has Lua work to do.
   *
   * To run Lua that must call back into JavaScript, or to start work from
   * inside a callback, use {@link execute_async} instead: it is
   * coroutine-driven and stays on the main thread, so it is not restricted this
   * way.
   *
   * @param script The Lua script to execute
   * Takes `{ chunkName }` like {@link execute_script} — see {@link ChunkNameOptions}.
   *
   * @returns Promise resolving with the result of the script execution
   * @throws If this thread already holds the Lua state (see above)
   */
  execute_script_async<T extends LuaValue | LuaValue[] = LuaValue>(
    script: string,
    options?: ChunkNameOptions
  ): Promise<T>;

  /**
   * Executes a Lua file asynchronously on a worker thread.
   * Returns a Promise that resolves with the result.
   * JS callbacks are not available during async execution.
   *
   * Subject to the same three refusal conditions as
   * {@link execute_script_async} — see there.
   *
   * @param filepath The path to the Lua file to execute
   * @returns Promise resolving with the result of the file execution
   * @throws If this thread already holds the Lua state
   */
  execute_file_async<T extends LuaValue | LuaValue[] = LuaValue>(filepath: string): Promise<T>;

  /**
   * Executes a Lua script as a coroutine on the **main thread**, transparently
   * awaiting JavaScript Promises returned by host functions.
   *
   * Unlike `execute_script_async` (which runs on a worker thread and forbids
   * callbacks), this runs on the main thread, so:
   * - JS callbacks work normally.
   * - When a host function (global, module function, or `obj:method()`) returns
   *   a Promise, the Lua coroutine suspends until it settles and resumes with
   *   the resolved value. A rejection is raised as a Lua error (catchable with
   *   `pcall`); an uncaught rejection rejects the returned Promise.
   *
   * The event loop stays free during the `await` gaps. Only one async operation
   * may run per context at a time (`is_busy()` is true meanwhile).
   *
   * Calling a Promise-returning host function in synchronous `execute_script`
   * throws — such functions must be awaited through one of the three async
   * doors: this one, {@link call_async}, or {@link resume_async}.
   *
   * @param script The Lua script to execute
   * Takes `{ chunkName }` like {@link execute_script} — see {@link ChunkNameOptions}.
   *
   * @returns Promise resolving with the script's return value(s)
   * @example
   * const lua = new lua_native.init({
   *   fetchUser: async (id) => (await db.get(id)),
   * }, { libraries: 'all' });
   * const name = await lua.execute_async(`
   *   local user = fetchUser(42)   -- suspends until the JS Promise resolves
   *   return user.name
   * `);
   */
  execute_async<T extends LuaValue | LuaValue[] = LuaValue>(
    script: string,
    options?: ChunkNameOptions
  ): Promise<T>;

  /**
   * Calls a Lua function **asynchronously**, so it may `await` host Promises.
   *
   * The awaiting counterpart to {@link call}, and the way to await inside a
   * function you hold rather than a script you write. Accepts either a global
   * name (including a dotted path, like `get_global`) or a `LuaFunction` this
   * context produced.
   *
   * Two things it does that `execute_async` cannot:
   *
   * - **A `LuaFunction` held only on the JavaScript side can await.** Routing
   *   through `execute_async` needs a *name* to call, so a function that was
   *   never stored as a global had no path to awaiting at all.
   * - **No chunk is compiled per call.** `execute_async('return f(1)')` parses a
   *   fresh chunk every time; this keeps the function a reference and calls it.
   *
   * Everything else matches `execute_async`: the same driver, the same
   * one-run-per-context rule (`is_busy()`), the same {@link cancel} behaviour,
   * and a rejection for any failure past argument validation.
   *
   * A callable table (`__call`) is refused, exactly as {@link call} refuses it.
   *
   * @param nameOrFn A global name, a dotted path, or a Lua function
   * @param args Arguments to pass to the function
   * @returns Promise resolving with the function's return value(s)
   * @example
   * lua.execute_script('function greet(id) return "hi " .. fetchName(id) end');
   * await lua.call_async('greet', 7);
   *
   * const fn = lua.execute_script('return function(id) return fetchName(id) end');
   * await lua.call_async(fn, 7);   // not reachable by name — the case this fixes
   */
  call_async<T extends LuaValue | LuaValue[] = LuaValue>(
    nameOrFn: string | LuaFunction, ...args: LuaInput[]): Promise<T>;

  /**
   * Cancels an in-flight asynchronous run. No-op if nothing is running.
   *
   * The two async families are cancelled by different mechanisms, and what you
   * can interrupt differs:
   *
   * **`execute_async` (main thread).** The suspended coroutine is abandoned and
   * the returned Promise rejects with an "execution cancelled" error. Because
   * JavaScript is single-threaded, this can only take effect while the script
   * is suspended awaiting a Promise — a synchronous Lua loop inside
   * `execute_async` never yields control back to `cancel()`.
   *
   * **`execute_script_async` / `execute_file_async` (worker thread).** The Lua
   * runs off-thread, so it *is* interruptible mid-loop — cooperatively, via the
   * same instruction count-hook that backs {@link LuaConfig.maxInstructions}.
   * The run rejects with "execution cancelled". This works only when that hook
   * is installed, which happens when **any** of `maxInstructions`, `timeout`,
   * or a {@link set_hook} with a `count` interval is configured. With none of
   * them set there is no hook, and a worker run cannot be interrupted at all —
   * set `timeout` if you want `cancel()` to be able to reach it.
   *
   * Not reachable from inside a *synchronous* `execute_script`: a host callback
   * that calls `cancel()` during one is a silent no-op, since neither async
   * family is in flight. Use `maxInstructions` or `timeout` to bound those.
   */
  cancel(): void;

  /**
   * Returns whether the context is currently busy with an async operation.
   * While busy, sync methods will throw and new async calls will be rejected.
   */
  is_busy(): boolean;

  /**
   * Returns the current memory usage of the Lua state in bytes.
   * This is tracked by the custom allocator and works regardless of
   * whether `maxMemory` was set.
   * @returns The current memory usage in bytes
   */
  get_memory_usage(): number;

  /**
   * Returns a diagnostics snapshot of this context: the Lua version it runs,
   * the memory it currently holds, and the limits and libraries it was
   * configured with.
   *
   * Everything reported is read from state the runtime already tracks, so this
   * runs no Lua code and never triggers a collection — safe to call on a timer
   * for monitoring. It throws only while an async operation is in flight.
   *
   * @example
   * lua.info();
   * // {
   * //   version: 'Lua 5.5', release: 'Lua 5.5.0', versionNumber: 505,
   * //   memoryBytes: 19532, memoryKB: 19.07,
   * //   memoryLimit: 0, maxInstructions: 0,
   * //   libraries: ['base', 'package', ...]
   * // }
   *
   * @example
   * // Monitor headroom against the configured cap
   * const { memoryBytes, memoryLimit } = lua.info();
   * if (memoryLimit > 0 && memoryBytes / memoryLimit > 0.9) reset();
   */
  info(): LuaStateInfo;

  /**
   * Compiles Lua source code to bytecode without executing it.
   * The returned Buffer can be saved to disk or passed to `load_bytecode()`.
   *
   * @param script The Lua source code to compile
   * @param options Optional compilation settings
   * @returns Buffer containing the compiled bytecode
   * @throws Error if the source has syntax errors
   * @example
   * const bytecode = lua.compile('return function(x) return x * 2 end');
   * fs.writeFileSync('my-script.luac', bytecode);
   */
  compile(script: string, options?: CompileOptions): Buffer;

  /**
   * Compiles a Lua file to bytecode without executing it.
   * The chunk name defaults to "@filepath" matching Lua convention.
   *
   * @param filepath Path to the Lua source file
   * @param options Optional compilation settings
   * @returns Buffer containing the compiled bytecode
   * @throws Error if the file cannot be read or has syntax errors
   * @example
   * const bytecode = lua.compile_file('./scripts/init.lua');
   */
  compile_file(filepath: string, options?: CompileOptions): Buffer;

  /**
   * Loads and executes precompiled Lua bytecode.
   * Only accepts binary bytecode (not source text). Use `execute_script()` for source.
   *
   * @param bytecode Buffer containing Lua bytecode (from `compile()`, `compile_file()`, or `luac`)
   * @param chunkName Optional name for error messages. Default: "bytecode"
   * @returns The result of executing the bytecode
   * @throws Error if the bytecode is invalid, corrupted, or from an incompatible Lua version
   * @example
   * const bytecode = lua.compile('return 42');
   * const result = lua.load_bytecode<number>(bytecode); // 42
   */
  load_bytecode<T extends LuaValue | LuaValue[] = LuaValue>(
    bytecode: Buffer,
    chunkName?: string
  ): T;

  /**
   * Create a new Lua table, optionally pre-populated with values.
   * Returns a handle for direct manipulation without execute_script.
   *
   * @param initial Optional initial values — a JS object for string keys,
   *   or an array for 1-indexed integer keys
   * @returns A live table handle
   * @example
   * const t = lua.create_table({ x: 1, y: 2 });
   * t.set('z', 3);
   * lua.set_global('point', t);
   * t.release();
   */
  create_table(initial?: { [key: string]: LuaInput } | LuaInput[]): LuaTableHandle;

  /**
   * Get a live reference to a global table.
   * Unlike get_global() which deep-copies plain tables, this returns a
   * handle that reads/writes the actual Lua table in place.
   *
   * @param name The global variable name
   * @returns A live table handle
   * @throws If the global does not exist or is not a table
   * @example
   * lua.execute_script('config = { host = "localhost", port = 5432 }');
   * const ref = lua.get_global_ref('config');
   * ref.get('host');  // 'localhost'
   * ref.set('debug', true);
   * ref.release();
   */
  get_global_ref(name: string): LuaTableHandle;

  /**
   * Create an environment table — a private global namespace a script can be
   * run in, so different scripts in the same context see different globals.
   *
   * The environment is an ordinary table reference: read and write it with the
   * handle methods to seed helpers or inspect what a script left behind, pass
   * it to {@link execute_script_in} to run code against it, and `release()` it
   * (or `lua.release(env)`) when done.
   *
   * Whitelisted names are copied by *value* — `math` in the environment is the
   * same table `_G.math` names, so a script that does `math.floor = nil`
   * changes it for everyone. Whitelist a name that is unset in `_G` and it is
   * simply absent. Whitelisting `'_G'` hands the script the real globals table
   * and defeats the isolation entirely.
   *
   * This restricts the global *namespace*, not the VM: use `maxMemory` and
   * `maxInstructions` for resource limits, and the `libraries` option to keep
   * dangerous libraries out of the context in the first place.
   *
   * @param options Which globals to seed, and whether to fall back to `_G`
   * @returns A live handle to the environment table
   * @example
   * const env = lua.create_environment({ whitelist: ['math', 'print'] });
   * env.set('answer', 42);
   * lua.execute_script_in(env, 'print(math.sqrt(16) + answer)');  // 46
   * lua.execute_script_in(env, 'return string.rep("x", 3)');      // throws: string is nil
   * env.release();
   */
  create_environment(options?: EnvironmentOptions): LuaEnvironment;

  /**
   * Execute a script with `env` installed as its `_ENV`, so the script's
   * global reads and writes resolve against that table instead of `_G`.
   *
   * Globals the script assigns land in `env` (visible via `env.get(...)`),
   * leaving the context's real globals untouched — even with
   * `inherit: true`, where reads fall through to `_G` but writes never do.
   *
   * Any table reference from this context works as an environment: an
   * environment from {@link create_environment}, a handle from
   * {@link create_table} or {@link get_global_ref}, or a metatabled-table
   * Proxy.
   *
   * Takes `{ chunkName }` like {@link execute_script} — see {@link ChunkNameOptions}.
   *
   * @param env The environment (or any table reference) to run against
   * @param script The Lua script to execute
   * @returns The result of the script execution
   * @throws If the script errors, or if `env` is not a live table reference
   *   from this context
   * @example
   * const env = lua.create_environment({ whitelist: ['print'] });
   * lua.execute_script_in(env, 'counter = 1');
   * env.get('counter');            // 1
   * lua.get_global('counter');     // null — the real globals are untouched
   */
  execute_script_in<T extends LuaValue | LuaValue[] = LuaValue>(
    env: LuaEnvironment | LuaTableHandle,
    script: string,
    options?: ChunkNameOptions
  ): T;

  /**
   * Registers a custom JS→Lua converter for values crossing into Lua.
   *
   * Converters are consulted in registration order, after internal round-trip
   * markers (metatabled-table Proxies and userdata handles) but before the
   * built-in handling of objects, arrays, and built-in types (Date, Map, Set,
   * Buffer, etc.). This lets application-specific types cross the boundary
   * under your control — and lets you override the built-in behavior for
   * types like Date or typed arrays.
   *
   * `match` is called with each object-typed value; if it returns a truthy
   * value, `convert` is called and its return value is converted to Lua
   * normally (so a converter may return a string, number, array, plain
   * object, etc.). Converters do not see primitives, functions, BigInt, or
   * Symbol values.
   *
   * Performance note: every registered `match` predicate runs for every
   * object-typed value crossing JS→Lua, in registration order, until one
   * matches. Keep `match` cheap and register only the converters you need.
   *
   * @param match Predicate deciding whether this converter applies to a value
   * @param convert Maps a matched value to a Lua-convertible JS value
   * @example
   * class Money { constructor(public cents: number) {} }
   * lua.register_type_converter(
   *   (v) => v instanceof Money,
   *   (v: Money) => ({ cents: v.cents, dollars: v.cents / 100 })
   * );
   * lua.set_global('price', new Money(1299));
   * lua.execute_script('return price.dollars'); // 12.99
   */
  register_type_converter(
    match: (value: unknown) => boolean,
    convert: (value: any) => LuaValue
  ): void;

  /**
   * Registers a converter for the Lua → JS direction: the mirror of
   * `register_type_converter`, for rebuilding application types out of the Lua
   * values that carry them.
   *
   * `match` is called with the value the built-in conversion produced — a plain
   * object for a Lua table, a Proxy for a metatabled one, the handle for opaque
   * userdata. If it returns a truthy value, `convert` is called and its return
   * value is used **verbatim**: the result is already a JS value, so unlike the
   * JS → Lua direction it is not converted again (which also means a converter
   * cannot loop by matching its own output).
   *
   * Converters are consulted at every level of the conversion, so they reach
   * values nested inside tables and arrays, and values arriving as callback
   * arguments — not just top-level results. They see only object-valued
   * results, mirroring how the JS → Lua direction skips primitives, which keeps
   * the common path free of a JS call per number and string. Registration order
   * decides precedence; the first match wins.
   *
   * Performance note: every registered `match` runs for every object-valued
   * result crossing Lua → JS, in registration order, until one matches. Keep
   * `match` cheap. Matching against a Proxy is not free either — each property
   * read runs the Lua `__index` path.
   *
   * @param match Predicate deciding whether this converter applies
   * @param convert Maps a matched value to the JS value the caller should see
   * @example
   * class Money { constructor(public cents: number) {} }
   *
   * // Lua -> JS
   * lua.register_from_lua_converter(
   *   (v: any) => v?.__type === 'Money',
   *   (v: any) => new Money(v.cents)
   * );
   * // JS -> Lua (the other half of the round trip)
   * lua.register_type_converter(
   *   (v) => v instanceof Money,
   *   (v: Money) => ({ __type: 'Money', cents: v.cents })
   * );
   *
   * lua.execute_script(`return { __type = 'Money', cents = 1299 }`);  // Money(1299)
   */
  register_from_lua_converter(
    match: (value: unknown) => boolean,
    convert: (value: any) => unknown
  ): void;

  /**
   * Registers a JavaScript class/usertype so Lua can construct and drive its
   * instances. Creates a global table `name` with a `new(...)` constructor.
   *
   * When Lua calls `name.new(...)`, the definition's `construct` function runs
   * and its returned object is held by reference as userdata bound to a shared
   * per-class metatable — so methods, property access, and overloaded operators
   * all dispatch back to JavaScript. Instances are garbage-collected by Lua.
   *
   * @param name The global class name in Lua (also the constructor table name)
   * @param definition Constructor, methods, metamethods, and property access flags
   * @example
   * class Vec {
   *   constructor(public x: number, public y: number) {}
   * }
   * lua.register_class('Vec', {
   *   construct: (x, y) => new Vec(x, y),
   *   readable: true,
   *   methods: {
   *     length: (self) => Math.hypot(self.x, self.y),
   *   },
   *   metamethods: {
   *     __add: (a, b) => new Vec(a.x + b.x, a.y + b.y),
   *     __tostring: (self) => `(${self.x}, ${self.y})`,
   *   },
   * });
   * lua.execute_script(`
   *   local a = Vec.new(3, 4)
   *   print(a:length())        -- 5
   *   print(tostring(a + Vec.new(1, 1)))  -- (4, 5)
   * `);
   */
  register_class(name: string, definition: ClassDefinition): void;

  /**
   * Calls a function in protected mode, returning a result object instead of
   * throwing. Mirrors Lua's `pcall`: on success `{ ok: true, value }`; on
   * failure `{ ok: false, error }`.
   *
   * Error fidelity is preserved — if the failure originated from a JS callback
   * that threw an `Error`, `error` is that original `Error` instance; otherwise
   * it is an `Error` whose message includes the Lua stack traceback.
   *
   * @param fn The function to call (typically a Lua function returned to JS)
   * @param args Arguments to pass to the function
   * @example
   * const fn = lua.execute_script<LuaFunction>('return function(x) if x < 0 then error("neg") end return x end');
   * const a = lua.pcall(fn, 5);   // { ok: true, value: 5 }
   * const b = lua.pcall(fn, -1);  // { ok: false, error: Error("...neg...") }
   */
  pcall(fn: LuaFunction | ((...args: LuaInput[]) => unknown), ...args: LuaInput[]): PcallResult;

  /**
   * Redirects Lua `print()` and `io.write()` output to a JavaScript handler.
   * The handler receives the fully-formatted output text — exactly what would
   * have been written to stdout (`print` joins its arguments with tabs, applies
   * `__tostring`, and appends a newline; `io.write` writes its arguments
   * verbatim). Pass `null` to restore output to stdout.
   *
   * @param handler Called with each chunk of output text, or `null` to clear
   * @example
   * const lines: string[] = [];
   * lua.set_print_handler((text) => lines.push(text));
   * lua.execute_script('print("hello", 42)'); // lines: ["hello\t42\n"]
   * lua.set_print_handler(null); // back to stdout
   *
   * @remarks
   * **An exception thrown by the handler is swallowed.** The handler runs
   * inside Lua's C call frame for `print` / `io.write`, and letting a C++
   * exception unwind through it would corrupt the VM — so the throw is
   * contained and the script continues exactly as though the output had
   * succeeded. Nothing is reported to the caller, and `execute_script` returns
   * normally. If the handler can fail in a way you need to know about, catch
   * inside it and record the failure yourself.
   */
  set_print_handler(handler?: ((text: string) => void) | null): void;

  /**
   * Routes Lua's `io.read` to a JavaScript handler — the input counterpart to
   * {@link set_print_handler}.
   *
   * Without it, a script that prompts for input has its *output* captured by a
   * print handler and then blocks on the process's real stdin, which in a
   * server or an Electron embedding is wrong twice over.
   *
   * The handler receives the requested format exactly as Lua passes it: a
   * string (`'l'` for a line — the default — `'L'`, `'a'` for the rest, `'n'`
   * for a number) or a **number** when the script asked for a byte count. A
   * leading `*` (the Lua 5.3 spelling) is stripped, so a handler only ever sees
   * one form. `io.read(f1, f2)` calls the handler once per format.
   *
   * Return the text, or `null`/`undefined` for end-of-input, which reaches Lua
   * as `nil` and stops the read there. (From untyped JS, a boolean return is
   * also treated as end-of-input rather than coerced to `"true"`/`"false"`.)
   * **An empty string is a valid empty line**, not end-of-input. For the `'n'` format the returned text is
   * converted to a number, or `nil` if it does not parse — matching real
   * `io.read('n')`.
   *
   * Pass `null` to restore the original `io.read`; no unwrap step is needed,
   * since the installed wrapper simply falls through when no handler is set.
   * The handler is re-installed automatically across {@link reset}.
   *
   * **Works without the `io` library.** There is no base-library input function
   * to override the way `print` gave output a home, so when `io` is absent — a
   * bare state, or `libraries: 'sandbox'` — a minimal `io` table holding only
   * `read` is created for the handler to live in. `io.read` is the *standard*
   * name, so a script written against a sealed context still runs on stock Lua,
   * and **the seal is not widened**: the table has no `open`, `lines`, `write`
   * or `stdout`. This is the same thing {@link set_file_reader} does for
   * `dofile`/`loadfile`, which `'sandbox'` also clears.
   *
   * Passing `null` removes a table created this way, so `io` goes back to `nil`
   * and a script's `if io then` sees what it saw before. Where `io` was the real
   * library, the wrapper stays and falls through to the original `io.read`, as
   * before.
   *
   * **"A table created this way" means that exact table.** If a script has
   * since replaced the global — `io = { read = io.read, mine = 1 }` — that is
   * the caller's value and is left alone; only the table this method itself
   * created is taken back. Conversely a script that merely reassigns `io.read`
   * inside our table does not save it: the table is still ours and still goes.
   * Fields a script added to the synthesized table are lost with it, which is
   * the intended trade — the table existed only to hold the handler.
   *
   * **Returns whether `io.read` is now wired to the handler.** The only `false`
   * case is a global `io` that exists and is not a table (`io = 42`): that value
   * is the caller's, so it is left alone rather than overwritten, and the handler
   * is not retained. Before the synthesis above, a bare or `'sandbox'` state
   * accepted the handler, stored it, wired nothing, and said nothing — see
   * `docs/LIMITATIONS.md` §8.
   *
   * Unlike the print handler, **a throwing read handler is not swallowed** — it
   * surfaces as a Lua error (`io.read handler failed: …`), because a read that
   * failed has no sensible value to continue with, whereas a print that failed
   * does.
   *
   * **The `format` argument is always a `string` or a `number`, in every mode.**
   * It is protocol metadata the binding mints (`'l'`, `'n'`, `'a'`, or a byte
   * count), not a value out of the script, so {@link LuaContextOptions.binaryStrings}
   * does not turn it into bytes — `format === 'n'` compares correctly under
   * either setting. (It did not until August 6, 2026; see CR-23 F2.)
   *
   * **The handler may return a `Uint8Array`/`Buffer` as well as a string**, and
   * its exact bytes reach Lua unchanged. That is the useful answer in a
   * `binaryStrings` context and the only way to feed Lua a byte sequence that is
   * not valid UTF-8.
   *
   * @param handler Called with each requested format, or `null` to clear
   * @returns `true` if `io.read` now reaches the handler
   * @example
   * const lines = ['Ada', '42'];
   * let i = 0;
   * lua.set_read_handler(() => (i < lines.length ? lines[i++] : null));
   * lua.execute_script('return io.read()');        // 'Ada'
   * lua.execute_script('return io.read("n")');     // 42 (a number)
   * @example
   * // Works in a sealed context, where it matters most.
   * const lua = new lua_native.init({}, { libraries: 'sandbox' });
   * lua.set_read_handler(() => 'Ada');             // true
   * lua.execute_script('return io.read()');        // 'Ada'
   * lua.execute_script('return type(io.open)');    // nil — still sealed
   */
  set_read_handler(
    handler?: ((format: string | number) =>
      string | Uint8Array | ArrayBuffer | null | undefined) | null): boolean;

  /**
   * Resolves `dofile` and `loadfile` through a JavaScript callback instead of
   * the filesystem — a virtual filesystem for the two entry points
   * {@link add_searcher} does not cover.
   *
   * It matters most under `libraries: 'sandbox'`, where both globals are
   * *cleared* precisely because they reach the real filesystem. Installing a
   * reader brings them back, backed only by what you choose to serve.
   *
   * **While a reader is installed, `dofile`/`loadfile` resolve through it
   * exclusively; the real filesystem is never consulted.** Deliberately not a
   * fallback chain — "the reader, or the disk if the reader declines" makes the
   * meaning of a path depend on the reader's answer. A reader that wants disk
   * access can read the disk itself.
   *
   * The reader returns Lua **source** for a path, or `null`/`undefined` for
   * "no such file", which `loadfile` reports as `nil, message` and `dofile`
   * raises — the shapes the real ones use. (From untyped JS, a boolean return
   * is also treated as "no such file" rather than coerced to text.) An empty
   * string is a valid empty file. Source is loaded in text-only mode, so a reader cannot hand back
   * bytecode and route around {@link LuaInitOptions.allowBytecode}.
   *
   * Pass `null` to remove the reader; the overrides are cleared back to `nil`
   * (which is what they were under `'sandbox'`, and what they must be rather
   * than a filesystem `dofile` this never captured). The reader is re-installed
   * automatically across {@link reset}.
   *
   * `require` is unaffected — use {@link add_searcher} for that.
   *
   * @param reader Called with the requested path, or `null` to clear
   * @example
   * const files: Record<string, string> = { '/lib/util.lua': 'return { add = function(a,b) return a+b end }' };
   * const lua = new lua_native.init({}, { libraries: 'sandbox' });
   * lua.set_file_reader((path) => files[path] ?? null);
   * lua.execute_script('return dofile("/lib/util.lua").add(2, 3)');   // 5
   */
  set_file_reader(
    reader?: ((path: string) => string | null | undefined) | null): void;

  /**
   * Installs a debug hook (`lua_sethook`) that reports execution events to a
   * JavaScript callback — the building block for profilers, tracers, and
   * debugger integrations.
   *
   * Setting a hook replaces any previous one. Call {@link remove_hook} to stop
   * tracing; calling it from inside the callback itself is safe and is the
   * usual way to trace only until some condition is met.
   *
   * **Cost.** `line` fires for every source line executed and crosses into JS
   * each time, which slows scripts down by orders of magnitude. Prefer `count`
   * with a coarse interval for sampling profilers.
   *
   * **Coroutines.** The hook is installed on the main state and inherited by
   * coroutine threads created *afterwards*, so set it before creating the
   * coroutines you want traced (the same rule as `maxInstructions`).
   *
   * **Async.** Hooks do not fire into JS during `execute_script_async` /
   * `execute_file_async`, which run Lua on a worker thread where calling
   * JavaScript is not permitted. Use `execute_async` (main thread) if you need
   * tracing with async.
   *
   * **Errors.** An exception thrown by the callback is swallowed rather than
   * corrupting the VM — the hook is a diagnostic channel, not a control one.
   * Use `maxInstructions` or `cancel()` to stop a running script.
   *
   * Coexists with `maxInstructions` and `cancel()`: they share one underlying
   * hook, so setting or removing a debug hook never disturbs them.
   *
   * @param callback Receives `(event, line, name)` for each event
   * @param options Which events to fire on — at least one is required
   * @throws If the callback is not a function, no event is requested, `count`
   *   is not a positive integer, or an async operation is in flight
   * @example
   * lua.set_hook((event, line) => {
   *   console.log(`${event} at line ${line}`);
   * }, { call: true, line: true });
   *
   * lua.execute_script(myScript);
   * lua.remove_hook();
   *
   * @example
   * // Sampling profiler: a count event every 10,000 instructions
   * const samples = new Map<number, number>();
   * lua.set_hook((_event, line) => {
   *   samples.set(line, (samples.get(line) ?? 0) + 1);
   * }, { count: 10_000 });
   *
   * @remarks
   * **An exception thrown by the callback is swallowed.** The hook runs between
   * VM instructions, inside Lua's execution, so a C++ exception unwinding
   * through it would corrupt the VM — the throw is contained and the script
   * continues. Nothing surfaces to the caller. To stop a script from the hook,
   * use {@link cancel} rather than throwing.
   */
  set_hook(callback: LuaHookCallback, options: HookOptions): void;

  /**
   * Removes the debug hook installed by {@link set_hook}. Safe to call when no
   * hook is set, and safe to call from inside the hook callback.
   *
   * `maxInstructions` and `cancel()` are unaffected — they use the same
   * underlying hook and keep working.
   */
  remove_hook(): void;

  /**
   * Read-only view of the Lua call stack, innermost frame first.
   *
   * **This is the half of debugger support that {@link set_hook} does not
   * provide.** A hook tells you *where* execution is; this tells you what the
   * stack looks like there, and {@link get_locals} tells you what its variables
   * hold. Together they are enough to build a breakpoint UI; a hook alone is
   * enough only for a profiler.
   *
   * Most useful from *inside* a hook callback or a host function, which is when
   * a stack exists. Outside execution it returns `[]` — the honest answer, and
   * usually the one the caller wanted to know.
   *
   * Each frame carries what Lua's own `lua_getinfo` reports: `level` (0 is
   * innermost), `source` and `shortSource` (the chunk name — see
   * {@link ChunkNameOptions}, which is what makes these legible), `currentLine`
   * and `lineDefined`, and `name` / `nameWhat` / `what` (`'Lua'`, `'C'` or
   * `'main'`). `name` is `''` where Lua cannot infer one.
   *
   * Refused while a worker-thread run is in flight
   * ({@link execute_script_async}), where the Lua state belongs to another
   * thread. A hook callback on the main thread is not that case and is allowed.
   *
   * @param options `maxLevels` caps how deep to walk (default 200)
   * @example
   * lua.set_hook((event, line) => {
   *   if (line === breakpoint) {
   *     console.log(lua.get_stack().map((f) => `${f.shortSource}:${f.currentLine}`));
   *     console.log(lua.get_locals(0));
   *   }
   * }, { line: true });
   */
  get_stack(options?: { maxLevels?: number }): LuaStackFrame[];

  /**
   * The named local variables visible at a stack level, with their values.
   *
   * `level` is as {@link get_stack} reports it — 0 is the innermost frame.
   * Values cross the boundary by the ordinary conversion rules, so
   * {@link LuaContextOptions.tableAs} and
   * {@link LuaContextOptions.binaryStrings} apply here too.
   *
   * Lua's compiler temporaries (the slots it names in parentheses, such as
   * `(temporary)` and `(for state)`) are **skipped**: they are bookkeeping, not
   * the caller's variables. A variable declared but not yet reached on the
   * current line is simply not there yet, which is Lua's scoping and not an
   * omission by this method.
   *
   * @param level Stack level, 0 = innermost
   * @returns The named locals in Lua's own order
   * @throws RangeError if no frame exists at `level` — deliberately not an
   *   empty array, so "no such frame" stays distinguishable from "a frame with
   *   no locals"
   */
  get_locals(level: number): Array<{ name: string; value: LuaValue }>;

  /**
   * Adds a module searcher backed by JavaScript, enabling dynamic/virtual
   * `require()`. When Lua requires a module not already loaded or found by
   * earlier searchers, `searcher(name)` is called; return the module's Lua
   * source as a string to provide it, or `null`/`undefined` to let the next
   * searcher try. Requires the `package` library.
   *
   * Unlike `register_module` (a static preload), this resolves modules lazily,
   * so sources can come from a bundle, database, or in-memory map. Searchers
   * must be synchronous. Requiring a module caches it as usual.
   *
   * @param searcher Maps a module name to its Lua source, or null if unknown
   * @example
   * const modules = { greet: 'return function(n) return "Hi " .. n end' };
   * lua.add_searcher((name) => modules[name] ?? null);
   * lua.execute_script('return require("greet")("Ada")'); // "Hi Ada"
   */
  add_searcher(searcher: (name: string) => string | null | undefined): void;

  /**
   * Releases the Lua registry reference held by a value that crossed the
   * boundary: a Lua function returned to JS, a coroutine, or a table
   * reference (a `LuaTableHandle` or a metatabled-table Proxy).
   *
   * Without an explicit release, such references occupy their registry slot
   * until the JS wrapper is garbage-collected, which for long-lived contexts
   * that mint many references can accumulate significant Lua-side memory.
   * Releasing lets Lua's GC reclaim the referent on its next cycle.
   *
   * After release, using the wrapper throws a clear error ("Lua function has
   * been released" / "coroutine has been released" / "table handle has been
   * released"). Releasing the same value again is a safe no-op. Equivalent to
   * `handle.release()` for table handles.
   *
   * @param value The Lua function, coroutine, or table reference to release
   * @example
   * const fn = lua.execute_script<LuaFunction>('return function(x) return x * 2 end');
   * fn(21);          // 42
   * lua.release(fn); // registry slot freed
   * fn(21);          // throws: Lua function has been released
   *
   * @remarks
   * **Releasing a coroutine does not run its to-be-closed variables.** This
   * frees the registry slot and executes nothing; use {@link close} first if a
   * suspended coroutine holds a `local x <close> = …` resource. The separation
   * is deliberate — see {@link close}.
   */
  release(value: LuaFunction | LuaCoroutine | LuaTableRef | LuaTableHandle): void;

  /**
   * Discards the Lua state and replaces it with a fresh one carrying the same
   * options, without creating a new context. Intended for long-lived server
   * processes that run many independent scripts and would otherwise accumulate
   * global state (and memory) indefinitely.
   *
   * **Replayed automatically** onto the new state: the callbacks object passed
   * to `init()`, the print handler, the debug hook, the `allowBytecode` guard,
   * every path added with `add_search_path`, every searcher added with
   * `add_searcher`, and the globals published from any `shared` table.
   * Registered type converters are pure JavaScript-side policy and are
   * unaffected.
   *
   * **Not replayed** — these bind to Lua-side objects that die with the old
   * state and must be re-applied after a reset: `set_global`, `set_userdata`,
   * `set_metatable`, `register_module`, and `register_class`.
   *
   * Values that previously crossed into JavaScript (Lua functions, coroutines,
   * table references, opaque userdata) belong to the old state and are
   * invalidated: using one afterwards throws rather than reaching into the new
   * state, with a message that names *this* cause — "its Lua state was replaced
   * by reset(); acquire a new handle" — as distinct from "its Lua context has
   * been destroyed", which means the `LuaContext` itself was garbage-collected.
   * A JavaScript `__gc` metamethod still fires during the reset, and a handle
   * it receives for the object being finalized is already in the invalidated
   * state: the object is mid-collection and will not exist a moment later. The old state itself is kept alive until the last such wrapper is
   * garbage-collected, so its memory is only reclaimed once they are gone —
   * `release()` them first to reclaim it immediately.
   *
   * **Throws in three distinct situations**, deliberately reported with three
   * distinct messages — they are different facts, and collapsing them into
   * "while Lua is executing" is what hid a use-after-free for four review
   * passes:
   *
   * 1. *An async operation is in flight* (`is_busy()` is true). This also
   *    covers the window in which a completed `execute_async` run's values are
   *    still being converted back to JavaScript — so a
   *    `register_from_lua_converter` handler running on an `execute_async`
   *    result cannot reset either. (The *worker* families,
   *    `execute_script_async` / `execute_file_async`, clear the busy flag
   *    before marshalling and hold condition 3 across it instead, so a
   *    converter running on one of their results is refused with message 3
   *    rather than message 1. The window is closed either way.)
   * 2. *Lua is executing* — from inside a host callback, metamethod, table
   *    trap, debug hook, or `__gc` finalizer, since the state being retired is
   *    the one those frames are running on. That includes a finalizer reached
   *    from `gc('collect')`, and a re-entrant `reset()` from a finalizer of the
   *    state a `reset()` is already retiring.
   * 3. *Another lua-native call is on the stack, running your JavaScript, with
   *    no Lua executing at all.* Every method starts by turning JS into
   *    something Lua can accept and ends by turning the result back — and those
   *    conversions run code you supplied: a registered type converter, a getter
   *    on a definition object passed to `set_metatable` / `register_class` /
   *    `set_userdata` / `register_module` / `set_hook`, or a `Proxy` trap on any
   *    object handed to the addon. `reset()` from one of those is refused,
   *    because the call it interrupted would finish its work against a state
   *    that no longer exists.
   *
   * @example
   * const lua = new lua_native.init({ log: console.log }, { libraries: 'safe' });
   * lua.execute_script('x = 42');
   * lua.reset();
   * lua.execute_script('return x');   // null — the state was reset
   * lua.execute_script('log("hi")');  // callbacks still work
   */
  reset(): void;

  /**
   * Runs a full garbage-collection cycle. Reclaims everything unreachable,
   * including running pending `__gc` finalizers.
   *
   * @example
   * lua.gc('collect');
   */
  gc(command: 'collect'): void;

  /**
   * Stops (`'stop'`) or resumes (`'restart'`) automatic collection. While
   * stopped, Lua collects only when you call `gc('collect')` or `gc('step')` —
   * useful for keeping a latency-sensitive batch free of collector pauses.
   *
   * A `maxMemory` limit stays enforced while the collector is stopped: Lua
   * still runs an emergency collection when an allocation would exceed the cap,
   * so stopping the collector cannot turn the limit into a spurious failure.
   *
   * @example
   * lua.gc('stop');
   * lua.execute_script('process_batch()');
   * lua.gc('restart');
   * lua.gc('collect');
   */
  gc(command: 'stop' | 'restart'): void;

  /**
   * Returns the memory Lua currently has in use, in kilobytes. The value has a
   * fractional part, so `gc('count') * 1024` is the exact byte count.
   *
   * This is Lua's own accounting; `get_memory_usage()` reports the same memory
   * in bytes as tallied by this binding's allocator.
   *
   * @example
   * const kb = lua.gc('count');
   */
  gc(command: 'count'): number;

  /** Returns whether automatic collection is currently running (not stopped). */
  gc(command: 'isrunning'): boolean;

  /**
   * Performs one garbage-collection step and returns whether the step finished
   * a collection cycle (in generational mode, a major collection).
   *
   * @param stepSize Number of bytes to treat as newly allocated; omit or pass 0
   *   for one basic step
   * @example
   * lua.gc('stop');
   * // Drive collection in small slices, interleaved with other work.
   * while (!lua.gc('step', 1024)) doSomeOtherWork();
   */
  gc(command: 'step', stepSize?: number): boolean;

  /**
   * Switches the collector mode and returns the previous mode. Generational
   * mode favors workloads that allocate many short-lived objects; incremental
   * mode spreads collection across smaller pauses.
   *
   * @example
   * const previous = lua.gc('generational'); // 'incremental'
   */
  gc(command: 'incremental' | 'generational'): LuaGCMode;

  /**
   * Reads or sets a collector tuning parameter, returning its previous value.
   * Omit `value` to read without changing anything. Values must be in the range
   * 0–100000.
   *
   * @param name The parameter to read or set
   * @param value The new value, or omit to read the current one
   * @example
   * const previousPause = lua.gc('param', 'pause');
   * lua.gc('param', 'pause', 400); // let the heap grow 4x before collecting
   */
  gc(command: 'param', name: LuaGCParam, value?: number): number;
}

/**
 * Garbage-collector modes reported and selected by `gc('incremental')` /
 * `gc('generational')`.
 */
export type LuaGCMode = 'incremental' | 'generational';

/**
 * Tunable garbage-collector parameters for `gc('param', name, value?)`. The
 * first three apply to generational mode, the last three to incremental mode.
 */
export type LuaGCParam =
  | 'minormul'
  | 'majorminor'
  | 'minormajor'
  | 'pause'
  | 'stepmul'
  | 'stepsize';

/**
 * Available Lua standard library names for selective loading
 */
export type LuaLibrary =
  | 'base'
  | 'package'
  | 'coroutine'
  | 'debug'
  | 'io'
  | 'math'
  | 'os'
  | 'string'
  | 'table'
  | 'utf8';

/**
 * Preset names for loading groups of standard libraries
 * - 'all': Load all 10 standard libraries
 * - 'safe': Load all except io, os, and debug. **Not a sandbox for untrusted
 *   code** — `base` still provides `dofile`/`loadfile` and `package` provides
 *   `require`, so the filesystem is reachable. See docs/LIMITATIONS.md §1.
 * - 'sandbox': 'safe' minus `package`, with `dofile`/`loadfile` cleared and
 *   `allowBytecode` defaulting to false. Sealed against filesystem access.
 */
export type LuaLibraryPreset = 'all' | 'safe' | 'sandbox';

/**
 * Options for configuring a new Lua context
 */
export interface LuaInitOptions {
  /**
   * Which Lua standard libraries to load. If omitted, NO libraries are loaded (bare state).
   *
   * - `'all'` — load all 10 standard libraries
   * - `'safe'` — load all except io, os, and debug.
   *
   *   **This is not a sandbox for untrusted code, despite the name.** It keeps
   *   `base` (which provides `dofile` and `loadfile`) and `package` (which
   *   provides `require`, with a writable `package.path`), so a script can
   *   execute any readable `.lua` file on the host. Driven and documented in
   *   `docs/LIMITATIONS.md` §1. Use `'sandbox'` instead if you need a seal.
   *
   * - `'sandbox'` — **the sealed preset, for untrusted code.** `'safe'` minus
   *   `package` (so no `require` and no `package.path`), with `dofile` and
   *   `loadfile` cleared from the globals — they live in `base`, so they
   *   cannot be removed by omitting a library — and `allowBytecode` defaulting
   *   to `false`, since `string.dump` + `load` would otherwise reach the
   *   bytecode loader. An explicit `allowBytecode: true` still wins.
   *   `base`, `coroutine`, `table`, `string`, `math` and `utf8` remain, so
   *   ordinary scripting is unaffected. The seal survives `reset()`.
   * - `LuaLibrary[]` — load specific libraries by name
   * - `[]` — bare state with no standard libraries
   *
   * @example
   * // Load all libraries
   * { libraries: 'all' }
   *
   * // Most of the standard library, without io/os/debug
   * { libraries: 'safe' }
   *
   * // Only load string and math
   * { libraries: ['base', 'string', 'math'] }
   */
  libraries?: LuaLibrary[] | LuaLibraryPreset;

  /**
   * Maximum memory (in bytes) the Lua state is allowed to allocate.
   * When the limit is reached, Lua throws an out-of-memory error.
   * Set to 0 or omit for unlimited memory.
   *
   * @example
   * // Limit to 10 MB
   * { maxMemory: 10 * 1024 * 1024 }
   *
   * // Limit to 256 KB (tight sandbox)
   * { maxMemory: 256 * 1024 }
   */
  maxMemory?: number;

  /**
   * Maximum number of Lua VM instructions a single execution may run before it
   * is aborted with an `"instruction limit exceeded"` error. This prevents an
   * infinite loop (`while true do end`) from hanging the process — the second
   * half of sandboxing alongside `maxMemory`. Set to 0 or omit for unlimited.
   *
   * The limit applies **per execution call**: each `execute_script`,
   * `execute_file`, `load_bytecode`, Lua-function call from JS, and each
   * coroutine `resume` gets a fresh budget — as does any other operation that
   * runs Lua, including a metamethod fired by a table handle, a Proxy read, or
   * access to a metatabled `_G`. Enforcement is approximate to within ~1000
   * instructions (the hook's sampling granularity).
   *
   * **Nested entries share the enclosing budget.** A Lua loop whose body calls
   * a JS callback that re-enters Lua does not restart the counter, so the limit
   * bounds the whole call tree rather than each re-entry separately.
   *
   * Best set at construction so every coroutine created afterward inherits the
   * limit.
   *
   * @example
   * // Abort runaway scripts after ~10 million instructions
   * { maxInstructions: 10_000_000 }
   *
   * // Resource-limited, but NOT sealed — see docs/LIMITATIONS.md §1
   * { libraries: 'safe', maxMemory: 256 * 1024, maxInstructions: 1_000_000 }
   *
   * // Sealed against untrusted code
   * { libraries: 'sandbox', maxMemory: 256 * 1024, maxInstructions: 1_000_000 }
   */
  maxInstructions?: number;

  /**
   * Maximum wall-clock time, in milliseconds, that a single execution may run
   * before it is aborted with an `"execution timeout"` error. Set to 0 or omit
   * for no timeout.
   *
   * Real time is the more intuitive budget; `maxInstructions` is the more
   * deterministic one. They are complements, not alternatives — set both and
   * whichever is reached first aborts the script.
   *
   * Like `maxInstructions`, the budget applies **per execution call**: each
   * `execute_script`, `execute_file`, `load_bytecode`, Lua-function call from
   * JS, and each coroutine `resume` starts a fresh deadline — as does any other
   * operation that runs Lua, including a metamethod fired by a table handle, a
   * Proxy read, or access to a metatabled `_G`. Nested entries share the
   * enclosing deadline rather than starting a new one. Time a script spends
   * suspended awaiting a JS Promise under `execute_async` is not counted — the
   * timeout bounds Lua compute per step, not the round trip.
   *
   * Enforcement is hook-driven, with two consequences: the deadline is checked
   * between VM instructions (so a single long-running C call — a huge
   * `string.rep`, or a host callback that blocks — is not interrupted), and
   * granularity is the hook's sampling interval rather than exactness. That
   * interval is every 1000 VM instructions, so the overshoot to expect is
   * however long 1000 instructions take on your hardware for the code being
   * run — tens of microseconds for a tight numeric loop on a 2026 laptop,
   * proportionally more where individual instructions are expensive. It does
   * not grow with the length of the timeout.
   *
   * The clock is monotonic, so a system time change cannot shorten or extend a
   * running script.
   *
   * @example
   * // Abort any script that runs longer than 5 seconds
   * { timeout: 5000 }
   *
   * // Belt and braces for untrusted code
   * { libraries: 'safe', maxMemory: 256 * 1024, maxInstructions: 1_000_000, timeout: 1000 }
   */
  timeout?: number;

  /**
   * Redirects Lua `print()` and `io.write()` to this handler (see
   * `set_print_handler`). The handler receives the formatted output text.
   * Equivalent to calling `set_print_handler` right after construction, and
   * takes precedence over a `print` provided in the callbacks object.
   */
  print?: (text: string) => void;

  /**
   * When `false`, this context refuses to load Lua bytecode: `load_bytecode()`
   * throws, and Lua's `load()` is forced to text-only mode so binary chunks are
   * rejected. Loading untrusted bytecode is unsafe, so disable it when running
   * untrusted scripts. Default: `true`.
   */
  /**
   * Return every Lua string as a `Uint8Array` of its raw bytes instead of
   * decoding it as UTF-8. Default: false.
   *
   * Lua strings are **byte** strings; JavaScript strings are UTF-16. By
   * default a string crossing out of Lua is decoded as UTF-8, so any byte
   * sequence that is not valid UTF-8 comes back with U+FFFD in place of each
   * bad byte — lossy, and *data-dependent*: `string.pack('i4', 7)` is all
   * low bytes and survives, so binary handling looks correct until a byte
   * goes above 0x7F. Turn this on for `string.pack`/`unpack`, compression,
   * crypto, image data or any binary protocol.
   *
   * **All-or-nothing per context, deliberately.** Returning bytes only when
   * the decode would have been lossy would make the return type depend on
   * the data, which is far harder to write correct code against. With this
   * on, every Lua string is a `Uint8Array` and text must be decoded by the
   * caller (`new TextDecoder().decode(bytes)`).
   *
   * Table **keys** are unaffected — a JS property key is a string either
   * way. Passing a `Uint8Array` back into Lua already produced a byte
   * string, so values round-trip.
   *
   * @example
   * const lua = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
   * const bytes = lua.execute_script('return string.pack("i4", 7)');
   * // → Uint8Array(4) [7, 0, 0, 0]
   */
  binaryStrings?: boolean;

  /**
   * Refuse a conversion that would silently lose data, instead of performing it.
   *
   * The losses in `docs/LIMITATIONS.md` §5 that happen **silently** become
   * errors naming what would have been lost and what to do instead:
   *
   * | Direction | Refused under `strictConversion` |
   * |---|---|
   * | JS → Lua | `null`/`undefined` inside an **array** (it becomes a Lua nil, which ends the sequence there) |
   * | JS → Lua | `null`/`undefined` as an **object value** (a nil removes the key rather than storing one) |
   * | Lua → JS | a table key that is neither string nor number (dropped — JS cannot key an object by boolean, table or function) |
   * | Lua → JS | a string key and a number key with the same text (`"1"` and `1` collapse to one property, and *which* value survives depends on table order) |
   * | Lua → JS | a table key whose **bytes** are not valid UTF-8, or contain a NUL — each bad byte becomes U+FFFD and a NUL truncates the name, so two distinct Lua keys can collapse into one JS property |
   *
   * Everything else is untouched. The two §5 entries that were already loud — a
   * circular reference and nesting past 100 levels — still throw their own
   * messages, and the BigInt widening past ±(2^53−1) is a *type* change rather
   * than a loss, so it is not affected. Values kept on the Lua side behind a
   * {@link LuaContext.get_global_ref} handle never convert and so never refuse.
   *
   * **The byte-key row is about keys only, and deliberately.** A lossy string
   * *value* is the separate question {@link binaryStrings} answers, and it
   * answers it by carrying the bytes rather than by refusing — a remedy is
   * better than an error whenever one exists. A key has no such switch, because
   * a JS property name is a string in every mode, so a refusal is the only
   * honest answer available. With both options on there is **no silent loss
   * left in either direction**, which is the strongest statement this API can
   * make about conversion.
   *
   * **All-or-nothing per context, deliberately** — the same rule
   * {@link binaryStrings} states, for the same reason. A mode that refused only
   * *some* lossy conversions would make behaviour depend on the data, which is
   * the defect class this option exists to surface.
   *
   * **Off by default**, because turning it on makes previously-working programs
   * throw. It is an opt-in diagnostic for embedders who would rather find out at
   * the boundary than downstream. A non-boolean value is rejected rather than
   * ignored, so a typo cannot quietly mean "off".
   *
   * @example
   * const lua = new lua_native.init({}, { libraries: 'all', strictConversion: true });
   * lua.set_global('rows', [1, null, 3]);         // throws: would truncate at index 1
   * lua.set_global('rows', [1, false, 3]);        // fine — false is a present value
   * lua.execute_script('return {["1"]="a",[1]="b"}');  // throws: keys collide
   * lua.execute_script('return {["\xFF"]="a"}');       // throws: key bytes are not UTF-8
   */
  strictConversion?: boolean;

  /**
   * How a Lua table arrives in JavaScript. Default `'object'`.
   *
   * `'map'` returns a **`Map`** instead of a plain object, which turns three of
   * the four Lua→JS key losses in `LIMITATIONS.md` §5 from losses into
   * representations — a `Map` can hold what a JS object cannot:
   *
   * | Lua table | `'object'` (default) | `'map'` |
   * |---|---|---|
   * | `{[1]="int", ["1"]="str"}` | `{ "1": "int" }` — one entry, one value **gone** | `Map { 1 => "int", "1" => "str" }` |
   * | `{[true]="yes"}` | `{}` — the key is dropped | `Map { true => "yes" }` |
   * | `{["\xFF"]=1}` under `binaryStrings` | key mangled to U+FFFD | `Map { Uint8Array[255] => 1 }` |
   *
   * **Every table becomes a Map, including sequences.** `{"a","b"}` arrives as
   * `Map { 1 => "a", 2 => "b" }`, not as an array — its keys are 1 and 2, and
   * in this mode you asked to see the keys. Making the shape depend on whether
   * the table *happened* to be a sequence is the data-dependent return type
   * that {@link binaryStrings} and {@link strictConversion} both refuse.
   *
   * **It round-trips.** A `Map` passed back into Lua keeps its key types in
   * this mode, so `1` and `"1"` stay distinct going in as well as coming out.
   * (In the default mode a Map's keys are stringified, matching plain-object
   * behaviour — that is unchanged.) A Map key that is not a string, number or
   * boolean is refused rather than stringified, the same rule
   * {@link LuaTableHandle.pairs} applies on the way out.
   *
   * **Composes with {@link strictConversion}**: there is nothing left for strict
   * mode to refuse on those three rows, so it refuses nothing — the pair is the
   * first configuration with **no silent loss and no refusal** in either
   * direction.
   *
   * A **metatabled** table is unaffected: it is still returned as a live Proxy
   * that preserves metamethods, in both modes. This option governs how a table
   * is *converted by value*, and a metatabled table deliberately is not.
   *
   * @example
   * const lua = new lua_native.init({}, { libraries: 'all', tableAs: 'map' });
   * const t = lua.execute_script('return {[1]="int", ["1"]="str"}');
   * t.get(1);     // 'int'
   * t.get('1');   // 'str'   — both survive
   */
  tableAs?: 'object' | 'map';

  /**
   * Whether this context will load **precompiled bytecode**. Defaults to `true`
   * everywhere except `libraries: 'sandbox'`, which defaults it to `false`; an
   * explicit value always wins.
   *
   * **Why it exists.** Lua does not verify undumped chunks, so malformed or
   * hostile bytecode is a memory-safety problem in a way that untrusted *source*
   * is not — source can only do what the loaded libraries allow. Setting this to
   * `false` is what keeps a script that can produce bytecode (`string.dump`)
   * from getting it back into the VM.
   *
   * **What `false` closes — all nine doors, since August 6, 2026:**
   *
   * | Door | Behaviour under `allowBytecode: false` |
   * |---|---|
   * | {@link LuaContext.load_bytecode} | throws |
   * | {@link LuaContext.execute_file}, {@link LuaContext.compile_file} | refuse a binary chunk |
   * | Lua `load` | forced to text mode |
   * | Lua `loadfile`, `dofile` | forced to text mode |
   * | `require`, via `package.path` or {@link LuaContext.add_search_path} | forced to text mode |
   * | A {@link LuaContext.set_file_reader} handler, a {@link LuaContext.add_searcher} searcher | already text-only in every mode |
   *
   * The five file doors were **open until August 6, 2026** — `loadfile`,
   * `dofile` and `require` are stock Lua C functions that load with mode
   * `"bt"`, so a script under `libraries: 'all'` could reach the loader with
   * `string.dump` → `io.write` → `dofile`, and under `'safe'` could load a
   * planted binary file. If you relied on that, pass `allowBytecode: true`.
   *
   * Text loading is unaffected: `require`, `dofile` and `loadfile` keep working
   * normally, including their error contracts (`loadfile` returns `nil, msg`;
   * `dofile` raises), and a `dofile` the script replaced is left alone.
   *
   * @example
   * const lua = new lua_native.init({}, { libraries: 'safe', allowBytecode: false });
   * lua.execute_script('return load(string.dump(function() end))');  // → nil
   * lua.execute_script('dofile("/tmp/precompiled.lua")');            // throws
   */
  allowBytecode?: boolean;

  /**
   * Whether Lua may reach the host filesystem at all. Default `'allow'`.
   *
   * `'deny'` closes **every** door from Lua to the disk in one option, which
   * previously took three calls and a caveat — `set_file_reader` covered
   * `dofile`/`loadfile`, `add_searcher` covered `require`, and `package.path`
   * stayed writable from inside the sandbox regardless.
   *
   * | Library | Denied |
   * |---|---|
   * | `base` | `dofile`, `loadfile` |
   * | `package` | `searchers[2]` (path), `searchers[3]`/`[4]` (cpath → **native code**), `loadlib`, `searchpath` |
   * | `io` | `open`, `lines`, `input`, `output` |
   * | `os` | `remove`, `rename`, `tmpname` |
   *
   * **`require` keeps working** for {@link LuaContext.register_module} modules
   * and {@link LuaContext.add_searcher} searchers — only the searchers that
   * read the disk are closed. That configuration had no expression before:
   * `'safe'` reaches the disk and `'sandbox'` has no `require` at all.
   *
   * **Each door refuses in its own idiom**, so scripts that already handle a
   * missing file keep working: `loadfile`, `io.open`, `os.remove`, `os.rename`,
   * `package.loadlib` and `package.searchpath` return `nil, message`, while
   * `dofile`, `io.lines`, `io.input`, `io.output` and `os.tmpname` raise — the
   * same shapes the real functions use to report failure. Every message names
   * the door and the policy. {@link LuaContext.add_search_path} refuses too,
   * rather than accepting a path `require` could never consult.
   *
   * **What it does not do, stated so the bound is not assumed.** It governs
   * what *Lua* can reach, not what the host can: {@link LuaContext.execute_file},
   * {@link LuaContext.compile_file} and a {@link LuaContext.set_file_reader}
   * handler all keep working, because the host asking for a file by name is the
   * caller's own decision. A file reader therefore re-opens `dofile`/`loadfile`
   * backed by the *host*, never by the disk. And it is not a general sandbox:
   * process execution (`os.execute`, `io.popen`) is not filesystem access and
   * is untouched — omit `os`/`io` if you need that gone.
   *
   * The seal is re-applied across {@link LuaContext.reset}, and cannot be
   * lifted for the lifetime of the context.
   *
   * @example
   * // Modules from the host, nothing from the disk.
   * const lua = new lua_native.init({}, { libraries: 'safe', filesystem: 'deny' });
   * lua.register_module('config', { env: 'prod' });
   * lua.execute_script('return require("config").env');   // 'prod'
   * lua.execute_script('dofile("/etc/passwd")');          // throws
   */
  filesystem?: 'allow' | 'deny';

  /**
   * Shared tables to publish as globals in this context, keyed by the global
   * name each should take. Every subscribing context receives the shared
   * table's current value at construction and every subsequent update.
   *
   * @example
   * const shared = lua_native.createSharedTable({ debug: true });
   * const lua1 = new lua_native.init({}, { shared: { settings: shared } });
   * const lua2 = new lua_native.init({}, { shared: { settings: shared } });
   * shared.set('debug', false);  // both contexts see settings.debug === false
   *
   * @see {@link SharedTable} for the propagation model and its limits
   */
  shared?: Record<string, SharedTable>;
}

/**
 * A JS-side value mirrored as a global in one or more Lua contexts.
 *
 * Lua states cannot share memory, so "shared" here means **synchronized
 * copies**: the shared table holds one JavaScript object and pushes it into
 * every subscribed context's global namespace. Subscribe a context by passing
 * the shared table in the `shared` init option.
 *
 * Propagation has two properties worth knowing:
 *
 * - **One-way (JS → Lua).** A Lua script that assigns into the shared global
 *   changes only its own context's copy; that edit is not seen by the other
 *   contexts and does not update the JS-side value. Read a context's own view
 *   back with `get_global()` if you need it.
 * - **Whole-value.** Each update re-pushes the entire value into every
 *   subscriber, so a large shared table costs proportionally on every `set()`
 *   or `sync()`.
 *
 * A context that rejects an update (one busy with an async operation, say) is
 * reported in the error thrown by `set()`/`sync()` — after every other context
 * has been updated. The JS-side value is always updated; `sync()` retries.
 *
 * Subscriptions do not keep a context alive: once a context is garbage
 * collected it is dropped from the subscriber list.
 *
 * @example
 * const shared = lua_native.createSharedTable({ mode: 'dev' });
 * const lua1 = new lua_native.init({}, { shared: { settings: shared } });
 * const lua2 = new lua_native.init({}, { shared: { settings: shared } });
 *
 * shared.set('mode', 'prod');
 * lua1.execute_script("return settings.mode");  // 'prod'
 * lua2.execute_script("return settings.mode");  // 'prod'
 */
export interface SharedTable {
  /**
   * Read a top-level field of the shared value. This reads the JavaScript-side
   * object, not any one context's copy — so a Lua-side edit is not reflected
   * here.
   */
  get(key: string): LuaValue;

  /**
   * Set a top-level field and immediately publish the whole value to every
   * subscribed context.
   *
   * @throws If a subscriber rejects the update. The JS-side value is still
   *   updated and the other contexts still receive it; call `sync()` to retry.
   */
  set(key: string, value: LuaInput): void;

  /**
   * Re-publish the current value to every subscribed context. Use it after
   * mutating the shared object directly (including through a nested object
   * returned by `get()`), or to retry a `set()` that a busy context rejected.
   *
   * @throws If a subscriber rejects the update.
   */
  sync(): void;
}

/**
 * The main Lua module interface
 */
export interface LuaNative {
  /**
   * Creates a new Lua context with the provided callbacks and values
   * @param callbacks Object containing functions and values to be available in Lua
   * @param options Optional configuration for the Lua context
   */
  init: new (callbacks?: LuaCallbacks, options?: LuaInitOptions) => LuaContext;

  /**
   * Creates a shared table: a JavaScript object that can be published as a
   * global in several Lua contexts and kept in step across them.
   *
   * The object is held, not copied — mutating the object you passed in and
   * calling `sync()` publishes the change, and `get()` returns live nested
   * objects.
   *
   * @param initial The object to share. Defaults to an empty object.
   * @example
   * const shared = lua_native.createSharedTable({ config: { debug: true } });
   * const lua = new lua_native.init({}, { shared: { settings: shared } });
   * lua.execute_script('return settings.config.debug');  // true
   */
  createSharedTable(initial?: Record<string, LuaInput> | LuaInput[]): SharedTable;
}
