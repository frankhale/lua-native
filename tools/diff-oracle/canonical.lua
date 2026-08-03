-- Canonical serialization for the differential oracle.
--
-- Both sides of the comparison end up producing a string in this format. On the
-- reference side this file runs inside stock Lua; on the lua-native side the
-- same file runs inside the embedded state (mode A) or its JavaScript mirror in
-- `js-canonical.mjs` produces the same form from the marshalled value (mode B).
--
-- **The erasures are the specification.** JavaScript cannot represent every Lua
-- value distinctly, so a raw comparison of the two sides would report hundreds
-- of differences that are the documented design of the binding rather than
-- defects — and an oracle that cries wolf is an oracle nobody runs. So the
-- distinctions JS provably cannot carry are erased *here*, once, each with its
-- reason, and everything that survives is a real disagreement.
--
-- Erased, and why:
--
--   * **integer vs float subtype, within +-2^53.** Lua 5.5 distinguishes 3 from
--     3.0 (`math.type`); JavaScript has one number type. The addon emits a
--     BigInt beyond +-(2^53 - 1), so above that the subtype *is* carried and is
--     therefore NOT erased — a large integer arriving as a float is a real
--     finding, and this form will show it.
--   * **table key iteration order.** `next` order is unspecified in Lua and
--     JS object key order is its own thing. Keys are sorted by (type, value).
--   * **function / thread / userdata identity.** These cross as opaque handles;
--     only the type name is comparable.
--
-- NOT erased, deliberately: the integer/float distinction of the *string* forms
-- ("1.5" stays "1.5"), NaN vs infinity vs -infinity, negative zero, string bytes
-- (escaped, so an encoding difference shows up rather than being normalised
-- away), and error message text.

local M = {}

local MAX_SAFE = 9007199254740991  -- 2^53 - 1

local function fmt_number(v)
  if math.type(v) == 'integer' then
    -- Beyond the safe range the addon emits a BigInt, which keeps the subtype,
    -- so keep it here too and let a mismatch be visible.
    if v > MAX_SAFE or v < -MAX_SAFE then return 'bigint:' .. string.format('%d', v) end
    return 'num:' .. string.format('%d', v)
  end
  -- Floats. Special values first: their default tostring is platform-flavoured.
  if v ~= v then return 'num:nan' end
  if v == math.huge then return 'num:inf' end
  if v == -math.huge then return 'num:-inf' end
  if v == math.floor(v) and v >= -MAX_SAFE and v <= MAX_SAFE then
    -- Integral float inside the safe range: indistinguishable from the integer
    -- once it is a JS number, so erase the subtype (see the header).
    if v == 0 and 1 / v < 0 then return 'num:-0' end
    return 'num:' .. string.format('%d', math.tointeger(v) or v)
  end
  -- %.17g round-trips an IEEE double exactly, so a real precision difference
  -- shows up instead of being rounded into agreement.
  return 'num:' .. string.format('%.17g', v)
end

local function fmt_string(s)
  local out = s:gsub('[%c\\"\128-\255]', function(c)
    return string.format('\\x%02X', string.byte(c))
  end)
  return 'str:"' .. out .. '"'
end

-- Sort key: group by type first so numbers and strings never compare against
-- each other (which would error), then by value within a type.
local function key_rank(k)
  local t = type(k)
  if t == 'number' then return 1 end
  if t == 'string' then return 2 end
  if t == 'boolean' then return 3 end
  return 4
end

local function sort_keys(keys)
  table.sort(keys, function(a, b)
    local ra, rb = key_rank(a), key_rank(b)
    if ra ~= rb then return ra < rb end
    if ra == 1 or ra == 2 then return a < b end
    if ra == 3 then return (a and 1 or 0) < (b and 1 or 0) end
    return tostring(a) < tostring(b)
  end)
  return keys
end

local canon

local function canon_table(v, depth, seen)
  if seen[v] then return 'cycle' end
  if depth > 12 then return 'deep' end
  seen[v] = true
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  sort_keys(keys)
  local parts = {}
  for i = 1, #keys do
    local k = keys[i]
    parts[#parts + 1] = canon(k, depth + 1, seen) .. '=' .. canon(v[k], depth + 1, seen)
  end
  seen[v] = nil
  return '{' .. table.concat(parts, ',') .. '}'
end

canon = function(v, depth, seen)
  depth = depth or 0
  seen = seen or {}
  local t = type(v)
  if t == 'nil' then return 'nil' end
  if t == 'boolean' then return v and 'true' or 'false' end
  if t == 'number' then return fmt_number(v) end
  if t == 'string' then return fmt_string(v) end
  if t == 'table' then return canon_table(v, depth, seen) end
  -- Opaque across the boundary; only the type name is comparable.
  return t
end

M.canon = canon
M.fmt_string = fmt_string

-- Runs `chunk_source` and canonicalizes the outcome. Both the value list and
-- the error path go through the same formatter so an error is a *result*, not
-- an absence of one — a snippet that errors on one side and succeeds on the
-- other must be visible as a difference rather than as a missing row.
function M.run(chunk_source)
  local fn, load_err = load(chunk_source, '=case')
  if not fn then
    return 'loaderror:' .. fmt_string(tostring(load_err))
  end
  local packed = table.pack(pcall(fn))
  local ok = packed[1]
  if not ok then
    return 'error:' .. canon(packed[2])
  end
  local parts = {}
  for i = 2, packed.n do
    parts[#parts + 1] = canon(packed[i])
  end
  return 'ok:[' .. table.concat(parts, ',') .. ']'
end

-- The mode-B form. Identical on success; on failure it reports the error's
-- *display string* rather than its canonicalized value, because that is what
-- the binding hands a JS caller and so is the thing the two sides can be asked
-- the same question about.
function M.run_b(chunk_source)
  local fn, load_err = load(chunk_source, '=case')
  if not fn then
    return 'error:' .. fmt_string(tostring(load_err))
  end
  local ok, err_or_value = pcall(fn)
  if not ok then
    return 'error:' .. fmt_string(tostring(err_or_value))
  end
  return 'ok:[' .. canon(err_or_value) .. ']'
end

-- Runs a whole batch and prints one `id \t modeA \t modeB` line per case.
--
-- Batched because the reference is a separate process: a spawn per case turned
-- a 1300-case corpus into a twenty-minute run, which is a corpus nobody runs
-- twice. One spawn for the whole thing brings it to seconds. Each case still
-- gets a fresh function environment via `load`, and cases that pollute globals
-- are the reason the *embedded* side still builds a fresh context per case —
-- that side is in-process and cheap.
function M.run_batch(cases)
  local out = {}
  for i = 1, #cases do
    local c = cases[i]
    local a = M.run(c.src)
    local b = M.run_b(c.src)
    out[#out + 1] = c.id .. '\t' .. a .. '\t' .. b
  end
  return table.concat(out, '\n')
end

return M
