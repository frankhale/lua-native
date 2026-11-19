-- A small top-down adventure, all of it in Lua.
--
-- The host (rpg/preload.cjs) provides three functions and calls four:
--
--   sprite(id, x, y, size, alt)   draw tile `id` from the tilesheet. `alt`
--                                 picks the second animation frame.
--   fill(x, y, w, h, color)       draw a rectangle
--   screen(w, h)                  declare the size of the screen, in pixels
--
--   update(dt)   once per frame, before draw()
--   draw()       once per frame
--   keypressed(key), keyreleased(key)
--   wheelmoved(direction)   optional; 1 is a notch down, -1 a notch up

local atlas = require('atlas')
local Map = require('map')
local text = require('text')
local ui = require('ui')

screen(ui.WIDTH, ui.HEIGHT)

local VIEW_W, VIEW_H = 15, 11  -- tiles across and down; odd, so the hero is central
local HALF_W, HALF_H = VIEW_W // 2, VIEW_H // 2
local TILE = 32        -- map tiles are drawn at twice their 16 pixels
local ORIGIN = 16      -- the map starts one frame cell in

local HERO, SHIP, GATE = 4 * 16 + 0, 6 * 16 + 2, 1 * 16 + 8
local CHEST_OPEN = 3 * 16 + 1

local game = {
  hp = 8,
  max_hp = 8,
  gold = 0,
  keys = 0,
  potions = 1,
  sunstone = false,
  quest = nil,
  turn = 0,
  aboard = false,
  log = {},    -- one row per line of text, oldest first; see say()
  scroll = 0,  -- how many of the newest rows are scrolled out of view
  stack = {},  -- where to return to when leaving a map
}

local maps = {}
local clock = 0
local visible = {}  -- [view row][view column] -> can the hero see that cell
local stale = true

local HISTORY = 400 -- rows of log kept for scrolling back
local last_said = nil

-- Add a message to the log, wrapped into rows. `head` marks its first row.
local function say(message)
  last_said = message
  local log = game.log
  for i, line in ipairs(text.wrap(message, ui.LOG_WIDTH)) do
    log[#log + 1] = { text = line, head = i == 1 }
  end
  -- Forget the oldest messages, a whole message at a time.
  while #log > HISTORY do
    repeat
      table.remove(log, 1)
    until log[1].head
  end
  game.scroll = 0 -- anything new brings the log back to the present
end

-- Scroll the log by rows: positive towards older ones. It stops once the
-- oldest row is on screen.
local function scroll_log(rows)
  for _ = 1, math.abs(rows) do
    if rows < 0 then
      if game.scroll == 0 then
        return
      end
      game.scroll = game.scroll - 1
    else
      local first = ui.log_window(game.log, game.scroll)
      if first <= 1 then
        return
      end
      game.scroll = game.scroll + 1
    end
  end
end

local function log_page()
  local first, last = ui.log_window(game.log, game.scroll)
  return math.max(1, last - first)
end

-- For walking into something solid. Leaning on a wall says so once.
local function bump(message)
  if message ~= last_said then
    say(message)
  end
end

local function get_map(name)
  if not maps[name] then
    maps[name] = Map.new(name, atlas[name])
  end
  return maps[name]
end

local function place(map, x, y)
  game.map, game.x, game.y = map, x, y
  stale = true
end

---------------------------------------------------------------------------
-- Moons and gates
---------------------------------------------------------------------------

-- Sela turns slowly and decides which gate stands open. Maren turns quickly
-- and decides where that gate leads. Each has eight phases; they start part
-- of the way round so that neither begins dark.
local function moons()
  return (game.turn // 16 + 1) % 8, (game.turn // 6 + 3) % 8
end

local function open_gate()
  local sela = moons()
  return sela // 2 + 1
end

local function gate_destination()
  local _, maren = moons()
  local to = maren // 2 + 1
  if to == open_gate() then
    to = to % 4 + 1
  end
  return to
end

---------------------------------------------------------------------------
-- Turns
---------------------------------------------------------------------------

local function free(map, x, y)
  if not map:inside(x, y) then
    return false
  end
  local cell = map:cell(x, y)
  return cell.walk and not cell.exit and not cell.enter
    and not map:thing_at(x, y) and not (x == game.x and y == game.y)
end

local function hurt(amount, message)
  game.hp = game.hp - amount
  say(message)
end

local function die()
  local world = get_map('world')
  local castle = get_map('castle')
  local door = world.entrances.castle
  game.stack = { { map = world, x = door.x, y = door.y } }
  game.hp = game.max_hp
  game.gold = game.gold // 2
  game.aboard = false
  place(castle, castle.start.x, castle.start.y)
  say('Darkness takes you... You wake at the castle gate, healed. Half your gold is gone.')
end

local STEPS = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

local function wander(map, thing)
  if math.random(3) ~= 1 then
    return
  end
  local step = STEPS[math.random(4)]
  local x, y = thing.x + step[1], thing.y + step[2]
  local reach = thing.wander
  if math.abs(x - thing.home_x) <= reach and math.abs(y - thing.home_y) <= reach and free(map, x, y) then
    thing.x, thing.y = x, y
  end
end

local function prowl(map, monster)
  local dx, dy = game.x - monster.x, game.y - monster.y
  local distance = math.abs(dx) + math.abs(dy)
  if distance == 1 then
    if math.random(2) == 1 then
      hurt(monster.damage, ('The %s hits you!'):format(monster.name))
    else
      say(('The %s misses.'):format(monster.name))
    end
    return
  end
  if distance > 7 or not map:sees(monster.x, monster.y, game.x, game.y) then
    return
  end
  -- Close the longer gap first; fall back to the other axis if blocked.
  local step_x = dx > 0 and 1 or -1
  local step_y = dy > 0 and 1 or -1
  local tries
  if math.abs(dx) >= math.abs(dy) then
    tries = { { step_x, 0 }, { 0, step_y } }
  else
    tries = { { 0, step_y }, { step_x, 0 } }
  end
  for _, try in ipairs(tries) do
    local x, y = monster.x + try[1], monster.y + try[2]
    if (try[1] ~= 0 and dx ~= 0 or try[2] ~= 0 and dy ~= 0) and free(map, x, y) then
      monster.x, monster.y = x, y
      return
    end
  end
end

local function end_turn()
  game.turn = game.turn + 1
  local map = game.map
  for _, thing in ipairs(map.things) do
    if thing.kind == 'npc' and thing.wander then
      wander(map, thing)
    elseif thing.kind == 'monster' then
      prowl(map, thing)
    end
  end
  if game.hp <= 0 then
    die()
  end
  stale = true
end

---------------------------------------------------------------------------
-- Moving between maps
---------------------------------------------------------------------------

local function enter(name)
  local map = get_map(name)
  game.stack[#game.stack + 1] = { map = game.map, x = game.x, y = game.y }
  place(map, map.start.x, map.start.y)
  say(('You enter %s.'):format(map.title))
end

local function leave()
  local back = table.remove(game.stack)
  say(('You leave %s.'):format(game.map.title))
  place(back.map, back.x, back.y)
end

---------------------------------------------------------------------------
-- Bumping into things
---------------------------------------------------------------------------

local LOOT = {
  gold = function(amount)
    game.gold = game.gold + amount
    return ('%d gold'):format(amount)
  end,
  potions = function(amount)
    game.potions = game.potions + amount
    return amount == 1 and 'a potion' or ('%d potions'):format(amount)
  end,
  keys = function(amount)
    game.keys = game.keys + amount
    return 'an iron key'
  end,
  sunstone = function()
    game.sunstone = true
    return 'the Sunstone! Take it to the king'
  end,
}

local function talk(npc)
  local reply
  if npc.talk then
    reply = npc.talk(game)
  else
    npc.said = (npc.said or 0) % #npc.lines + 1
    reply = npc.lines[npc.said]
  end
  say(('%s: %s'):format(npc.name, reply))
end

local function open_chest(chest)
  if chest.opened then
    say('The chest is empty.')
    return
  end
  chest.opened = true
  chest.sprite = CHEST_OPEN
  local found = {}
  for what, amount in pairs(chest.loot) do
    found[#found + 1] = LOOT[what](amount)
  end
  say(('You open the chest: %s.'):format(table.concat(found, ', ')))
end

local function attack(map, monster)
  if math.random(4) == 1 then
    say(('You miss the %s.'):format(monster.name))
    return
  end
  monster.hp = monster.hp - math.random(3)
  if monster.hp > 0 then
    say(('You strike the %s.'):format(monster.name))
    return
  end
  map:remove(monster)
  local coins = math.random(2, 6)
  game.gold = game.gold + coins
  say(('The %s falls. You find %d gold.'):format(monster.name, coins))
end

local function interact(map, thing)
  if thing.kind == 'npc' then
    talk(thing)
  elseif thing.kind == 'sign' then
    say(('The sign reads: %s'):format(thing.text))
  elseif thing.kind == 'chest' then
    open_chest(thing)
  elseif thing.kind == 'monster' then
    attack(map, thing)
  end
  end_turn()
end

local function open_door(map, x, y, cell)
  if cell.locked then
    if game.keys == 0 then
      bump('The door is locked.')
      return
    end
    game.keys = game.keys - 1
    say('The key turns. The door swings open.')
  else
    say('You open the door.')
  end
  map:set(x, y, cell.door)
  end_turn()
end

---------------------------------------------------------------------------
-- Walking
---------------------------------------------------------------------------

local function arrive()
  local map = game.map
  local cell = map:cell(game.x, game.y)
  if cell.exit then
    leave()
    return
  end
  if cell.enter then
    enter(cell.enter)
    return
  end
  if cell.note then
    say(cell.note)
  end
  if cell.heal and game.hp < game.max_hp then
    game.hp = game.max_hp
    say(cell.heal)
  end
  if cell.hurt and math.random(cell.hurt.chance) == 1 then
    hurt(1, cell.hurt.text)
  end
  local gate = map.gates[open_gate()]
  if gate and gate.x == game.x and gate.y == game.y then
    local to = map.gates[gate_destination()]
    game.x, game.y = to.x, to.y
    say('You step into the gate. The world folds, and you are elsewhere.')
  end
  end_turn()
end

-- `fresh` is false while a key is held down. A held key keeps walking but
-- never talks, fights or opens anything, so nothing happens by accident.
local function move(dx, dy, fresh)
  local map = game.map
  local x, y = game.x + dx, game.y + dy

  if not map:inside(x, y) then
    if map.edge_exit then
      leave()
    elseif fresh then
      bump('The open sea is too rough to cross.')
    end
    return
  end

  local cell = map:cell(x, y)
  local thing = map:thing_at(x, y)

  if thing and thing.kind == 'ship' then
    map:remove(thing)
    game.aboard = true
    game.x, game.y = x, y
    say('You board the ship. Steer for open water.')
    end_turn()
    return
  end

  if thing then
    if fresh then
      interact(map, thing)
    end
    return
  end

  if game.aboard then
    if cell.water then
      game.x, game.y = x, y
      end_turn()
    elseif cell.walk then
      local ship = { kind = 'ship', sprite = SHIP, name = 'ship', x = game.x, y = game.y }
      map.things[#map.things + 1] = ship
      game.aboard = false
      game.x, game.y = x, y
      say('You step ashore.')
      arrive()
    elseif fresh then
      bump(cell.block or 'Blocked!')
    end
    return
  end

  if cell.door then
    if fresh then
      open_door(map, x, y, cell)
    end
    return
  end

  -- A shopkeeper can be spoken to across the counter.
  if cell.counter then
    local keeper = map:thing_at(x + dx, y + dy)
    if fresh and keeper and keeper.kind == 'npc' then
      interact(map, keeper)
    end
    return
  end

  if not cell.walk then
    if fresh then
      bump(cell.block or 'Blocked!')
    end
    return
  end

  if cell.slow and math.random(4) == 1 then
    say('Slow progress!')
    end_turn()
    return
  end

  game.x, game.y = x, y
  arrive()
end

local function drink()
  if game.potions == 0 then
    say('You have no potions.')
  elseif game.hp >= game.max_hp then
    say('You are not hurt.')
  else
    game.potions = game.potions - 1
    game.hp = math.min(game.max_hp, game.hp + 4)
    say('You drink a potion. Warmth spreads through you.')
    end_turn()
  end
end

---------------------------------------------------------------------------
-- Input
---------------------------------------------------------------------------

local DIRECTIONS = {
  up = { 0, -1 }, down = { 0, 1 }, left = { -1, 0 }, right = { 1, 0 },
  w = { 0, -1 }, s = { 0, 1 }, a = { -1, 0 }, d = { 1, 0 },
}

local FIRST_REPEAT, NEXT_REPEAT = 0.25, 0.11

local held = nil
local repeat_in = 0

function keypressed(key)
  local direction = DIRECTIONS[key]
  if direction then
    held = key
    repeat_in = FIRST_REPEAT
    move(direction[1], direction[2], true)
  elseif key == 'space' then
    say('You wait.')
    end_turn()
  elseif key == 'p' then
    drink()
  elseif key == 'pageup' then
    scroll_log(log_page())
  elseif key == 'pagedown' then
    scroll_log(-log_page())
  end
end

function wheelmoved(direction)
  scroll_log(-direction)
end

function keyreleased(key)
  if key == held then
    held = nil
  end
end

function update(dt)
  clock = clock + dt
  if held then
    repeat_in = repeat_in - dt
    if repeat_in <= 0 then
      repeat_in = NEXT_REPEAT
      local direction = DIRECTIONS[held]
      move(direction[1], direction[2], false)
    end
  end
end

---------------------------------------------------------------------------
-- Drawing
---------------------------------------------------------------------------

local function look()
  local map = game.map
  for row = 0, VIEW_H - 1 do
    local line = visible[row] or {}
    visible[row] = line
    for col = 0, VIEW_W - 1 do
      line[col] = map:sees(game.x, game.y, game.x + col - HALF_W, game.y + row - HALF_H)
    end
  end
  stale = false
end

local function draw_map(alt)
  local map = game.map
  if stale then
    look()
  end

  fill(ORIGIN, ORIGIN, VIEW_W * TILE, VIEW_H * TILE, '#000')

  for row = 0, VIEW_H - 1 do
    for col = 0, VIEW_W - 1 do
      if visible[row][col] then
        local cell = map:cell(game.x + col - HALF_W, game.y + row - HALF_H) or map.outside
        local x, y = ORIGIN + col * TILE, ORIGIN + row * TILE
        if cell.base then
          sprite(cell.base, x, y, TILE, alt)
        end
        sprite(cell.tile, x, y, TILE, alt)
      end
    end
  end

  local function draw_at(id, map_x, map_y)
    local col, row = map_x - game.x + HALF_W, map_y - game.y + HALF_H
    if col >= 0 and col < VIEW_W and row >= 0 and row < VIEW_H and visible[row][col] then
      sprite(id, ORIGIN + col * TILE, ORIGIN + row * TILE, TILE, alt)
    end
  end

  local gate = map.gates[open_gate()]
  if gate then
    draw_at(GATE, gate.x, gate.y)
  end
  for _, thing in ipairs(map.things) do
    draw_at(thing.sprite, thing.x, thing.y)
  end
  sprite(game.aboard and SHIP or HERO, ORIGIN + HALF_W * TILE, ORIGIN + HALF_H * TILE, TILE, alt)
end

function draw()
  -- Everything animated has two frames; swap twice a second.
  local alt = math.floor(clock * 2) % 2 == 1

  fill(0, 0, ui.WIDTH, ui.HEIGHT, ui.BACKGROUND)
  draw_map(alt)
  ui.frame()
  ui.moons(moons())
  ui.panel(game, game.map.title)
end

---------------------------------------------------------------------------

local world = get_map('world')
place(world, world.start.x, world.start.y)
say('Welcome to Aldermoor.')
say('The king has sent for you. His castle stands just to the west.')

-- A global, so the state can be inspected from outside (a test, say).
_G.game = game
