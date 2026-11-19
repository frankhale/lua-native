-- The screen around the map: a line frame, a status panel and a message log.
-- The screen is a grid of 16-pixel cells, 48 across and 24 down. The map
-- takes the left 22 by 22 of them and draws its tiles at double size.

local text = require('text')

local ui = {
  WIDTH = 768,
  HEIGHT = 384,
  BACKGROUND = '#2d2a3a',
  LOG_WIDTH = 22,  -- characters of message text per line
  LOG_LINES = 17,  -- lines the log has room for
}

local CELL = 16
local COLS, ROWS = 48, 24
local SPLIT = 23  -- column of the line between map and panel
local PANEL = 24  -- first column inside the panel
local LOG_TOP = 6
local LOG_GAP = 6  -- pixels between one message and the next
local BULLET = 8 * 16 + 15  -- the gold dash

-- Frame pieces, on tilesheet row 15.
local H, V = 240, 241
local TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT = 242, 243, 244, 245
local TEE_DOWN, TEE_UP, TEE_RIGHT, TEE_LEFT = 246, 247, 248, 249
local TAPER_RIGHT, TAPER_LEFT = 251, 252  -- a line narrowing to a point

local MOON = 16 * 16 + 4  -- eight phases, new moon first
local HEART, EMPTY_HEART = 9 * 16 + 10, 9 * 16 + 11
local COIN, GEM, KEY, POTION = 6 * 16 + 5, 6 * 16 + 6, 6 * 16 + 7, 6 * 16 + 8

local function put(id, col, row)
  sprite(id, col * CELL, row * CELL)
end

local function rule(row, left, right, from, to)
  put(left, from, row)
  for col = from + 1, to - 1 do
    put(H, col, row)
  end
  put(right, to, row)
end

function ui.frame()
  rule(0, TOP_LEFT, TEE_DOWN, 0, SPLIT)
  rule(0, TEE_DOWN, TOP_RIGHT, SPLIT, COLS - 1)
  rule(ROWS - 1, BOTTOM_LEFT, TEE_UP, 0, SPLIT)
  rule(ROWS - 1, TEE_UP, BOTTOM_RIGHT, SPLIT, COLS - 1)
  for row = 1, ROWS - 2 do
    put(V, 0, row)
    put(V, SPLIT, row)
    put(V, COLS - 1, row)
  end
  rule(2, TEE_RIGHT, TEE_LEFT, SPLIT, COLS - 1)
  rule(5, TEE_RIGHT, TEE_LEFT, SPLIT, COLS - 1)
end

-- The two moons sit in a gap in the top edge of the map frame. The line
-- tapers to a point on either side of them.
function ui.moons(first, second)
  fill(9 * CELL, 0, 5 * CELL, CELL, ui.BACKGROUND)
  put(TAPER_RIGHT, 9, 0)
  put(MOON + first, 10, 0)
  put(MOON + second, 12, 0)
  put(TAPER_LEFT, 13, 0)
end

local function counter(icon, amount, col)
  put(icon, col, 4)
  text.white(tostring(amount), (col + 1) * CELL, 4 * CELL)
end

function ui.panel(game, title)
  local width = COLS - 1 - PANEL
  local indent = (width - #title) // 2
  text.gold(title, (PANEL + indent) * CELL, CELL)

  for i = 1, game.max_hp do
    put(i <= game.hp and HEART or EMPTY_HEART, PANEL + i - 1, 3)
  end
  counter(COIN, game.gold, PANEL)
  counter(KEY, game.keys, PANEL + 6)
  counter(POTION, game.potions, PANEL + 11)
  if game.sunstone then
    put(GEM, PANEL + 16, 4)
  end

  ui.log(game.log)
end

-- The message log. Each message starts with a gold dash, its later lines are
-- indented under the first, and a small gap separates it from the next, so
-- it is clear where one message ends and another begins.
function ui.log(log)
  -- Show as many of the newest messages as fit.
  local room = ui.LOG_LINES * CELL
  local first = #log + 1
  while first > 1 do
    local need = #log[first - 1] * CELL + (first <= #log and LOG_GAP or 0)
    if need > room then
      break
    end
    room = room - need
    first = first - 1
  end

  local y = LOG_TOP * CELL
  for i = first, #log do
    sprite(BULLET, PANEL * CELL, y)
    for _, line in ipairs(log[i]) do
      text.white(line, (PANEL + 1) * CELL, y)
      y = y + CELL
    end
    y = y + LOG_GAP
  end
end

return ui
