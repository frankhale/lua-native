-- Two metatabled tables, so each crosses back to JS as a live table reference
-- rather than a deep copy. Used by the CODE-REVIEW-14 F1 pins: the FIRST value's
-- conversion is what runs the Lua->JS converter, and the SECOND is the one that
-- would be mis-bound if that converter could retire the state mid-marshal.
return setmetatable({ tag = 'A' }, {}), setmetatable({ tag = 'B' }, {})
