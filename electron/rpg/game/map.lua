-- A map instance: the grid of cells and the things standing on it, built
-- from one of the definitions in atlas.lua. Coordinates are 1-based.

local Map = {}
Map.__index = Map

function Map.new(name, def)
  local self = setmetatable({
    name = name,
    title = def.title,
    legend = def.legend,
    light = def.light,          -- how far the player can see; nil = unlimited
    edge_exit = def.edge_exit,  -- walking off the edge leaves the map
    outside = def.legend[def.outside],
    width = #def.rows[1],
    height = #def.rows,
    cells = {},
    things = {},
    gates = {},
    entrances = {},
  }, Map)

  for y, row in ipairs(def.rows) do
    if #row ~= self.width then
      error(('map %s: row %d is %d wide, expected %d'):format(name, y, #row, self.width))
    end
    local line = {}
    for x = 1, self.width do
      local ch = row:sub(x, x)
      local spawn = def.spawn and def.spawn[ch]
      if spawn then
        ch = spawn.floor
        if spawn.kind == 'start' then
          self.start = { x = x, y = y }
        elseif spawn.kind == 'gate' then
          self.gates[spawn.index] = { x = x, y = y }
        else
          local thing = { x = x, y = y, home_x = x, home_y = y }
          for key, value in pairs(spawn) do
            thing[key] = value
          end
          self.things[#self.things + 1] = thing
        end
      end
      local cell = def.legend[ch]
      if not cell then
        error(('map %s: unknown character %q at column %d, row %d'):format(name, ch, x, y))
      end
      if cell.enter then
        self.entrances[cell.enter] = { x = x, y = y }
      end
      line[x] = cell
    end
    self.cells[y] = line
  end

  if not self.start then
    error(('map %s has no start position'):format(name))
  end
  return self
end

function Map:inside(x, y)
  return x >= 1 and y >= 1 and x <= self.width and y <= self.height
end

function Map:cell(x, y)
  local row = self.cells[y]
  return row and row[x]
end

function Map:set(x, y, ch)
  self.cells[y][x] = self.legend[ch]
end

function Map:thing_at(x, y)
  for _, thing in ipairs(self.things) do
    if thing.x == x and thing.y == y then
      return thing
    end
  end
  return nil
end

function Map:remove(thing)
  for i, other in ipairs(self.things) do
    if other == thing then
      table.remove(self.things, i)
      return
    end
  end
end

function Map:opaque(x, y)
  local cell = self:cell(x, y)
  return cell ~= nil and cell.opaque == true
end

-- Line of sight, the way the old tile games did it: walk a straight line
-- from the eye to the target and stop at the first cell that blocks the view.
-- The target itself is always shown, so walls and tree lines are visible.
function Map:sees(from_x, from_y, x, y)
  if self.light then
    local dx, dy = x - from_x, y - from_y
    if dx * dx + dy * dy > self.light * self.light + 1 then
      return false
    end
  end
  local dx, dy = math.abs(x - from_x), math.abs(y - from_y)
  local step_x = from_x < x and 1 or -1
  local step_y = from_y < y and 1 or -1
  local err = dx - dy
  local cx, cy = from_x, from_y
  while cx ~= x or cy ~= y do
    if (cx ~= from_x or cy ~= from_y) and self:opaque(cx, cy) then
      return false
    end
    local twice = 2 * err
    if twice > -dy then
      err = err - dy
      cx = cx + step_x
    end
    if twice < dx then
      err = err + dx
      cy = cy + step_y
    end
  end
  return true
end

return Map
