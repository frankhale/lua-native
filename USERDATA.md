# Lua Userdata Support

Userdata is Lua's mechanism for representing foreign data - objects that originate outside of Lua and whose internal structure Lua doesn't understand. In lua-native, this means JavaScript objects.

Today, lua-native converts values eagerly between JS and Lua. Numbers, strings, booleans, and tables are copied across the boundary. This works well for data, but falls apart when you need **identity** - when Lua code needs to hold a reference to a specific JS object and pass it back later, not a copy of its properties.

Userdata solves this. It lets Lua hold onto a JS object without converting it, and optionally interact with its properties through metamethods.

## What Userdata Enables

### Object Identity Across the Boundary

Without userdata, passing a JS object to Lua means converting it to a Lua table. The connection to the original object is lost. Any mutations Lua makes to the table are invisible to JS, and vice versa.

```typescript
// Without userdata: Lua gets a disconnected copy
const connection = { host: 'localhost', port: 5432, connected: false };

const lua = new lua_native.init({
  connect: (conn) => {
    // conn is a plain object copied from Lua - NOT the original
    // Mutating conn here does nothing to the Lua-side table
    conn.connected = true; // This change is lost
  }
});

lua.set_global('conn', connection);
lua.execute_script('connect(conn)');
console.log(connection.connected); // still false
```

With userdata, Lua holds a reference to the actual JS object:

```typescript
// With userdata: Lua holds the real object
const connection = { host: 'localhost', port: 5432, connected: false };

const lua = new lua_native.init({
  connect: (conn) => {
    // conn IS the original JS object
    conn.connected = true; // Mutates the real object
  }
});

lua.set_userdata('conn', connection);
lua.execute_script('connect(conn)');
console.log(connection.connected); // true
```

The JS object is never serialized into a Lua table. Lua stores a reference ID that maps back to the original object when it crosses the boundary again.

### Resource Handles

Some objects shouldn't be copied - they represent resources with lifecycle semantics. Database connections, file handles, network sockets, timers. Userdata lets Lua code hold and pass these around without lua-native trying to decompose them into tables.

```typescript
class DatabaseConnection {
  private pool: ConnectionPool;

  query(sql: string): Record<string, unknown>[] { /* ... */ }
  close(): void { /* ... */ }
}

const db = new DatabaseConnection(/* ... */);

const lua = new lua_native.init({
  runQuery: (dbHandle, sql) => {
    // dbHandle is the actual DatabaseConnection instance
    return dbHandle.query(sql);
  },
  closeDb: (dbHandle) => {
    dbHandle.close();
  }
});

lua.set_userdata('db', db);

lua.execute_script(`
  -- db is opaque to Lua - it can't inspect it, but it can pass it around
  local results = runQuery(db, "SELECT * FROM users")

  for _, row in ipairs(results) do
    print(row.name)
  end

  closeDb(db)
`);
```

Without userdata, there's no clean way to give Lua a handle to the database connection. You'd have to store it outside Lua entirely and use string keys or indices to reference it - essentially reimplementing userdata manually.

### Automatic Cleanup via `__gc`

Full userdata participates in Lua's garbage collector. When Lua no longer references the userdata, its `__gc` metamethod fires, which lua-native uses to release the JS object reference. This prevents memory leaks without requiring manual cleanup.

```typescript
const lua = new lua_native.init({
  createBuffer: () => {
    const buf = Buffer.alloc(1024 * 1024); // 1MB buffer
    return buf; // Returned as userdata
  }
});

lua.execute_script(`
  local buf = createBuffer()
  -- use buf...
  buf = nil
  collectgarbage() -- __gc releases the JS Buffer reference
`);
// The 1MB Buffer is now eligible for JS garbage collection too
```

Without `__gc`, the JS-side reference map would grow indefinitely. Every JS object passed into Lua would stay alive forever unless manually released.

### Property Access from Lua

With `__index` and `__newindex` metamethods, Lua code can read and write properties on JS objects directly, as if they were Lua tables.

```typescript
const player = {
  name: 'Alice',
  health: 100,
  x: 0,
  y: 0,
  inventory: ['sword', 'shield']
};

const lua = new lua_native.init({});

// readable + writable: Lua can get and set properties
lua.set_userdata('player', player, { readable: true, writable: true });

lua.execute_script(`
  print(player.name)       -- "Alice" (reads from JS object)
  print(player.health)     -- 100

  player.x = 10            -- Updates the JS object directly
  player.y = 20
  player.health = 80

  -- Property reads go through __index, which calls back to JS
  -- Property writes go through __newindex, which calls back to JS
  -- The JS object is always the source of truth
`);

console.log(player.x);      // 10 - Lua's writes are visible in JS
console.log(player.health); // 80
```

This is where userdata becomes more than a handle - it becomes a live bridge. Lua scripts can manipulate JS state naturally using Lua's dot syntax, with every read and write crossing the boundary transparently.

### Read-Only Objects

Property access can be restricted. A read-only userdata lets Lua inspect an object without modifying it - useful for configuration, game state that scripts should observe but not change, or any scenario where Lua is sandboxed.

```typescript
const config = {
  maxPlayers: 16,
  mapName: 'de_dust2',
  tickRate: 128,
  debug: false
};

const lua = new lua_native.init({});

// readable but not writable
lua.set_userdata('config', config, { readable: true, writable: false });

lua.execute_script(`
  print(config.maxPlayers)   -- 16 (works)
  print(config.mapName)      -- "de_dust2" (works)

  config.maxPlayers = 64     -- Error: cannot write to read-only userdata
`);
```

## Use Cases for lua-native

### Scripting Engine for Applications

Applications that embed Lua as a scripting layer need to expose their internal objects to scripts. Userdata is the standard mechanism for this in Lua. Without it, lua-native can pass data to Lua but can't pass *objects* - things with identity, methods, and mutable state.

```typescript
// A UI framework exposing widgets to Lua scripts
const button = document.createElement('button');
button.textContent = 'Click me';

const lua = new lua_native.init({});
lua.set_userdata('button', button, { readable: true, writable: true });

lua.execute_script(`
  button.textContent = "Don't click me"
  button.disabled = true
`);
```

### Game Modding

Games that support Lua modding pass game objects (entities, components, vectors) as userdata. Modders interact with the game through these handles. Without userdata, every game object would need to be serialized to a Lua table and deserialized back on every frame - a performance and correctness problem.

```typescript
const entities: Map<number, Entity> = new Map();

const lua = new lua_native.init({
  getEntity: (id) => {
    return entities.get(id); // Returns as userdata - Lua gets a live reference
  },
  spawnProjectile: (origin, direction) => {
    // origin and direction are the actual entity/vector objects
    const pos = { x: origin.x, y: origin.y };
    // ...
  }
});

lua.execute_script(`
  local player = getEntity(1)
  local enemy = getEntity(2)

  -- These are live references to JS objects, not copies
  if player.health > 0 then
    spawnProjectile(player, enemy)
  end
`);
```

### Plugin Systems

Plugins written in Lua often receive a context or API object from the host. Userdata is the natural way to provide this - a single opaque handle that the plugin passes to API functions.

```typescript
class PluginContext {
  private pluginName: string;

  log(message: string): void { /* ... */ }
  getStorage(): Record<string, unknown> { /* ... */ }
  registerCommand(name: string, handler: () => void): void { /* ... */ }
}

const ctx = new PluginContext('my-plugin');

const lua = new lua_native.init({
  log: (context, msg) => context.log(msg),
  getStorage: (context) => context.getStorage(),
  registerCommand: (context, name, handler) => {
    context.registerCommand(name, handler);
  }
});

lua.set_userdata('ctx', ctx);

// Plugin script
lua.execute_script(`
  log(ctx, "Plugin loaded")
  local data = getStorage(ctx)
  registerCommand(ctx, "hello", function()
    log(ctx, "Hello from plugin!")
  end)
`);
```

### Passing Lua-Created Userdata Through JS

Some Lua standard library functions return userdata (e.g., `io.open` returns a file handle). Today, these are silently converted to `null` because lua-native doesn't handle the `LUA_TUSERDATA` type. With userdata passthrough support, these handles can survive a round-trip through JS even though JS can't inspect them.

```typescript
const lua = new lua_native.init({
  processFile: (fileHandle) => {
    // fileHandle is opaque - JS can't read from it directly
    // But it can pass it back to Lua functions that know how to use it
    return fileHandle;
  }
});

lua.execute_script(`
  local f = io.open("data.txt", "r")

  -- Pass the file handle through JS and back
  local same_f = processFile(f)

  -- Lua can still use it because it's the same userdata
  local content = same_f:read("*a")
  same_f:close()
`);
```

## What Userdata Is Not

Userdata is not a replacement for table conversion. When you want to pass a plain data structure (a config object, a list of numbers, query results), converting to a Lua table is correct and efficient. Userdata is for when you need one or more of:

- **Identity**: The Lua-side value must refer to the same JS object, not a copy
- **Mutability**: Changes made in Lua must be visible in JS (or vice versa)
- **Lifecycle**: The JS object must stay alive as long as Lua references it, and be released when Lua is done
- **Opacity**: Lua should be able to hold and pass the value without understanding its structure
