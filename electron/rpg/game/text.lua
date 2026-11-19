-- Bitmap text. The tilesheet carries two fonts, one glyph per 16x16 tile:
-- a white one with lower case, and a gold upper-case one for headings.

local text = {}

local CELL = 16

local white = {}
do
  local first = 17 * 16
  for i = 0, 25 do
    white[65 + i] = first + i
    white[97 + i] = first + 26 + i
  end
  for i = 0, 9 do
    white[48 + i] = first + 52 + i
  end
  white[string.byte('.')] = first + 62
  white[string.byte(',')] = first + 63
  local marks = [[!?'"-+:;/()%*=<>]]
  for i = 1, #marks do
    white[marks:byte(i)] = 21 * 16 + i - 1
  end
end

local gold = {}
do
  for i = 0, 25 do
    gold[65 + i] = 7 * 16 + i
    gold[97 + i] = 7 * 16 + i -- no lower case: fold it
  end
  for i = 0, 9 do
    gold[48 + i] = 9 * 16 + i
  end
  local marks = { ['.'] = 138, [','] = 139, ['!'] = 140, ['?'] = 141, ["'"] = 142, ['-'] = 143,
                  [':'] = 256, ['/'] = 257, ['('] = 258, [')'] = 259 }
  for mark, id in pairs(marks) do
    gold[mark:byte()] = id
  end
end

local function draw(font, str, x, y)
  for i = 1, #str do
    local id = font[str:byte(i)]
    if id then
      sprite(id, x, y)
    end
    x = x + CELL
  end
end

function text.white(str, x, y)
  draw(white, str, x, y)
end

function text.gold(str, x, y)
  draw(gold, str, x, y)
end

-- Word-wrap to a list of lines no longer than `width` characters.
function text.wrap(str, width)
  local lines, line = {}, ''
  for found in str:gmatch('%S+') do
    local word = found -- a loop variable cannot be assigned to
    while #word > width do
      if line ~= '' then
        lines[#lines + 1] = line
        line = ''
      end
      lines[#lines + 1] = word:sub(1, width)
      word = word:sub(width + 1)
    end
    if line == '' then
      line = word
    elseif #line + 1 + #word <= width then
      line = line .. ' ' .. word
    else
      lines[#lines + 1] = line
      line = word
    end
  end
  if line ~= '' then
    lines[#lines + 1] = line
  end
  return lines
end

return text
