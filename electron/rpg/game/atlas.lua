-- The world, as data. Each map is a list of text rows; `legend` says what
-- terrain a character is, and `spawn` says what stands on it: a person, a
-- chest, a monster. A tile is named by its row and column on the tilesheet.
--
-- Cell fields:
--   tile     what to draw            base    drawn underneath a see-through tile
--   walk     can be walked on        water   can be sailed on
--   opaque   blocks line of sight    slow    sometimes costs a turn
--   block    said when bumped into   note    said when stepped on
--   enter    name of the map this leads into
--   exit     leads back out          door    what it becomes when opened

local function T(row, col)
  return row * 16 + col
end

local atlas = {}

---------------------------------------------------------------------------
-- The overworld
---------------------------------------------------------------------------

local world_legend = {
  ['~'] = { tile = T(0, 0), water = true, block = 'The sea is too deep to wade.' },
  ['-'] = { tile = T(0, 1), water = true, block = 'The water is too deep to wade.' },
  ['.'] = { tile = T(0, 2), walk = true },
  [','] = { tile = T(0, 3), walk = true },
  ['f'] = { tile = T(0, 4), walk = true, opaque = true },
  ['p'] = { tile = T(0, 5), walk = true, opaque = true },
  ['h'] = { tile = T(0, 6), walk = true, slow = true },
  ['^'] = { tile = T(0, 7), opaque = true, block = 'The mountains are impassable.' },
  ['A'] = { tile = T(0, 8), opaque = true, block = 'The peaks are sheer ice.' },
  ['s'] = { tile = T(0, 9), walk = true },
  ['%'] = { tile = T(0, 10), walk = true, slow = true,
            hurt = { chance = 5, text = 'The swamp saps your strength!' } },
  ['L'] = { tile = T(0, 11), walk = true, hurt = { chance = 1, text = 'The lava burns!' } },
  ['d'] = { tile = T(0, 12), walk = true },
  ['='] = { tile = T(0, 13), walk = true },
  ['#'] = { tile = T(0, 15), walk = true },

  -- Places.
  ['T'] = { tile = T(1, 1), walk = true, enter = 'town' },
  ['C'] = { tile = T(1, 2), walk = true, enter = 'castle' },
  ['c'] = { tile = T(1, 5), walk = true, enter = 'cave' },
  ['V'] = { tile = T(1, 0), walk = true, note = 'A sleepy hamlet. Nobody is about.' },
  ['w'] = { tile = T(1, 3), walk = true, note = "A wizard's tower, sealed long ago." },
  ['r'] = { tile = T(1, 4), walk = true, note = 'Ruins of an older kingdom.' },
  ['t'] = { tile = T(1, 6), walk = true, heal = 'A calm settles over you. Your wounds close.' },
  ['F'] = { tile = T(1, 7), walk = true, note = 'A ring of standing stones. The air hums.' },
  ['*'] = { tile = T(1, 10), block = 'Someone left a campfire burning.' },
  ['o'] = { tile = T(1, 11), block = 'A well of cool, clear water.' },
  ['l'] = { tile = T(1, 12), block = 'The lighthouse door is barred.' },
  ['m'] = { tile = T(1, 13), block = 'The windmill creaks in the breeze.' },
  ['M'] = { tile = T(1, 14), walk = true, note = 'The old mine is boarded up.' },
  ['g'] = { tile = T(1, 15), walk = true, note = 'Weathered graves. You feel uneasy.' },

  -- The Frostmarch, in the north.
  ['S'] = { tile = T(13, 0), walk = true },
  ['W'] = { tile = T(13, 1), walk = true, slow = true },
  ['b'] = { tile = T(13, 2), walk = true },
  ['P'] = { tile = T(13, 3), walk = true, opaque = true },
  ['k'] = { tile = T(13, 4), walk = true, slow = true },
  ['K'] = { tile = T(13, 5), opaque = true, block = 'The peaks are sheer ice.' },
  ['I'] = { tile = T(13, 6), walk = true },
  ['J'] = { tile = T(13, 7), block = 'Pack ice blocks the way.' },
  ['E'] = { tile = T(13, 9), walk = true, note = 'An igloo. A fire glows inside.' },
  ['N'] = { tile = T(13, 10), walk = true, note = 'Huts huddle against the cold.' },

  -- The Sunsea desert, in the south-east.
  ['D'] = { tile = T(14, 0), walk = true, slow = true },
  ['u'] = { tile = T(14, 1), walk = true },
  ['x'] = { tile = T(14, 2), walk = true },
  ['y'] = { tile = T(14, 3), walk = true },
  ['R'] = { tile = T(14, 4), walk = true, slow = true },
  ['B'] = { tile = T(14, 5), opaque = true, block = 'The mesa is too steep to climb.' },
  ['O'] = { tile = T(14, 6), walk = true, heal = 'You drink deeply at the oasis.' },
  ['Q'] = { tile = T(14, 7), walk = true,
            hurt = { chance = 1, text = 'Something bites from under the sand!' } },
  ['Y'] = { tile = T(14, 9), walk = true, note = 'The pyramid has no door you can find.' },
  ['Z'] = { tile = T(14, 10), walk = true, note = 'The bazaar is closed for the season.' },
  ['n'] = { tile = T(14, 11), walk = true, note = "A nomad's tent, empty for now." },
}

atlas.world = {
  title = 'Aldermoor',
  outside = '~',
  legend = world_legend,
  spawn = {
    ['@'] = { kind = 'start', floor = '.' },
    ['&'] = { kind = 'ship', floor = '-', sprite = T(6, 2), name = 'ship' },
    ['1'] = { kind = 'gate', index = 1, floor = '.' },
    ['2'] = { kind = 'gate', index = 2, floor = '.' },
    ['3'] = { kind = 'gate', index = 3, floor = '.' },
    ['4'] = { kind = 'gate', index = 4, floor = '.' },
    ['i'] = { kind = 'sign', floor = '.', sprite = T(1, 9),
              text = 'North, the Frostmarch. East, Gloomdeep. South, Brightwater.' },
    ['j'] = { kind = 'sign', floor = '.', sprite = T(1, 9),
              text = 'Brightwater, west. Beyond lies the Sunsea. Carry water.' },
  },
  rows = {
    '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~~~~JJ--------------------JJ~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~JJ--SSSSSWWSSSSKKKSSSSSSSSS--JJ~~~~~~~~~~~~',
    '~~~~~~~~~~~J---SSSPPSSSSSSKKKKKSSSWWSSSSSS---~~~~~~~~~~~',
    '~~~~~~~~~~---SSSSPPPSSNSSSSKKKSSSSSSSbSSSSSS--~~~~~~~~~~',
    '~~~~~~~~~--SSSWWSSSSSSSSSSSSS.2.SSSPPSSSSSSkSS--~~~~~~~~',
    '~~~~~~~~--SSSSSSSbSSkkSSSISSSS.SSSSPPPSSEESSSSS--~~~~~~~',
    '~~~~~~~~--SSSkSSSSSSSSSIIISSSSSSbSSSSSSSSSSSKKS--~~~~~~~',
    '~~~~~~~--..SSSSSS..SSSSSISSS..SSSSSS..SSSSSKKKK--~~~~~~~',
    '~~~~~~~--....pp.....ff....,,......pp....hh^^^^^--~~~~~~~',
    '~~~~~~--..,..ppp...fff..---...,,..ppp..hh^^AA^^^--~~~~~~',
    '~~~~~~--......V.....f..-----......f..hhh^^AAAA^LL--~~~~~',
    '~~~~~--...ff.....1....--~~~--.......hhhh^^^AA^^LLL--~~~~',
    '~~~~~--..ffff.......,..-----..,,...hh.h^^^^^^^^^LL--~~~~',
    '~~~~~--..ff..m##........--........hh..h^^c^^^M^^h.--~~~~',
    '~~~~--.......###C.......-.....ff...h...hh.hh^.^hh..--~~~',
    '~~~~--..,,...###ddddddd=dddd.fff.....*....hh...h...--~~~',
    '~~~~--.......##.d.@....-...d..ff.........j.........--~~~',
    '~~~~--..o........F.....-...d........,,..........,..--~~~',
    '~~~~--............,....--..d....ff.................--~~~',
    '~~~~~--..%%.........ff..-..d...ffff......sss......--~~~~',
    '~~~~~--.%%%%..g....fff..-..d....ff.....sssssss...--~~~~~',
    '~~~~~--%%w%%%......ff...--.d..........sDDsssxss..--~~~~~',
    '~~~~~--%%%%%%%..........-..d...i.....ssDDDss.3.ss--~~~~~',
    '~~~~~~--%%r%%%.....,,...-.dd........ssysOssD...Yss--~~~~',
    '~~~~~~--.%%%%....,......-.T.......ussssyssRsDDssss--~~~~',
    '~~~~~~~--..%%.........----&--......usxssssBssnZss--~~~~~',
    '~~~~~~~~--.........------~~~--......ssssQsssRsss--~~~~~~',
    '~~~~~~~~~--------------~~~~~~~--.....sssxssssss--~~~~~~~',
    '~~~~~~~~~~~~-------~~~~~~~~~~~~~---------------~~~~~~~~~',
    '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~-----~~~~~~~~~~~~~~~',
    '~~~~~~~~-------~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~--sss..----~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~--s.ff.t.l.--~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~--s4.f..sss--~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~--sssss----~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~--------~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  },
}

---------------------------------------------------------------------------
-- Brightwater, a town
---------------------------------------------------------------------------

local WOOD, STONE, GRASS = T(2, 1), T(2, 0), T(0, 2)

local town_legend = {
  ['.'] = { tile = T(0, 2), walk = true },
  [','] = { tile = T(0, 3), walk = true },
  ['t'] = { tile = T(0, 4), block = 'A sturdy old oak.' },
  ['d'] = { tile = T(0, 12), walk = true },
  ['-'] = { tile = T(0, 1), block = 'The pond is too deep to wade.' },
  [':'] = { tile = STONE, walk = true },
  ['_'] = { tile = WOOD, walk = true },
  ['#'] = { tile = T(2, 3), opaque = true },
  ['W'] = { tile = T(2, 6) },
  ['+'] = { tile = T(2, 8), opaque = true, door = '/' },
  ['/'] = { tile = T(2, 9), walk = true },
  ['='] = { tile = T(2, 15), counter = true },
  ['o'] = { tile = T(1, 11), block = 'A well of cool, clear water.' },
  ['F'] = { tile = T(3, 10), base = STONE, block = 'The fountain murmurs.' },
  ['b'] = { tile = T(3, 2), base = WOOD, block = 'A barrel of salted fish.' },
  ['c'] = { tile = T(3, 3), base = WOOD, block = 'A crate, nailed shut.' },
  ['T'] = { tile = T(3, 4), base = WOOD },
  ['h'] = { tile = T(3, 5), base = WOOD },
  ['e'] = { tile = T(3, 6), base = WOOD, block = 'No time to rest.' },
  ['k'] = { tile = T(3, 7), base = WOOD, block = 'Ledgers and old almanacs.' },
}

atlas.town = {
  title = 'Brightwater',
  outside = '.',
  edge_exit = true,
  legend = town_legend,
  spawn = {
    ['@'] = { kind = 'start', floor = 'd' },
    ['i'] = { kind = 'sign', floor = '.', sprite = T(1, 9),
              text = 'Brightwater. Trading post to the west, the Gull Inn to the east.' },
    ['1'] = {
      kind = 'npc', floor = '_', sprite = T(4, 10), name = 'Trader',
      talk = function(game)
        if game.gold < 15 then
          return 'Potions, fifteen gold apiece. Come back with a heavier purse.'
        end
        game.gold = game.gold - 15
        game.potions = game.potions + 1
        return 'Fifteen gold. One potion. A pleasure!'
      end,
    },
    ['2'] = {
      kind = 'npc', floor = '_', sprite = T(4, 5), name = 'Bard', wander = 2,
      lines = {
        'Two moons, Sela and Maren. Sela opens a gate. Maren says where it leads.',
        'They say an isle lies south-west, with a shrine that mends any wound.',
        'A ship is moored at the quay south of town. Nobody has claimed it.',
      },
    },
    ['3'] = {
      kind = 'npc', floor = '.', sprite = T(4, 8), name = 'Farmer', wander = 4,
      lines = {
        'Mind the swamp out west. It drains the life from you.',
        'Hills and dunes are slow going. Keep to the road if you can.',
      },
    },
    ['4'] = {
      kind = 'npc', floor = '_', sprite = T(4, 3), name = 'Healer',
      talk = function(game)
        if game.hp >= game.max_hp then
          return 'You are in good health. Go with care.'
        end
        if game.gold < 10 then
          game.hp = math.min(game.max_hp, game.hp + 2)
          return 'No coin? Then take a little mending for free.'
        end
        game.gold = game.gold - 10
        game.hp = game.max_hp
        return 'Ten gold, and you are whole again.'
      end,
    },
    ['5'] = {
      kind = 'npc', floor = '.', sprite = T(4, 9), name = 'Villager', wander = 5,
      lines = {
        'The king looks worried of late.',
        'My brother went into Gloomdeep. He came back pale and would not speak.',
      },
    },
    ['6'] = {
      kind = 'npc', floor = '_', sprite = T(4, 14), name = 'Sage',
      lines = {
        'Gloomdeep? The vault there is locked. The goblins keep its key in the north-west chamber.',
        'Step off a road onto a forest and you see only the trees beside you.',
      },
    },
    ['7'] = {
      kind = 'npc', floor = '.', sprite = T(4, 11), name = 'Guard',
      lines = { 'Welcome to Brightwater. Walk off any edge of town to leave.' },
    },
  },
  rows = {
    '................................',
    '..tt........................t...',
    '..#########.....##########......',
    '..#bk_=___#.....#e_e#_T__#..t...',
    '..#c_1=___#..i..#___+__2_W......',
    '..#b__=___#.....#e__#_Th_#......',
    '..######+##.....#####+####......',
    '.7......d............d..........',
    '@ddddddddddddddddddddddddddddd..',
    '........d....d:::d........d.....',
    '..,.....d....:::::........d..t..',
    '........d....::F::...3....d.....',
    '..######+#...:::::....####+###..',
    '..#__b___#...d:::d....#______#..',
    '..W_4____#...d........#_k__k_W..',
    '..#e___e_#...d...5....#__6___#..',
    '..########...d........########..',
    '.....o.......d..,...............',
    '..t..........d.............tt...',
    '.....----....d.....,............',
    '....------...d..................',
    '.....----....d..................',
  },
}

---------------------------------------------------------------------------
-- Castle Aldermoor
---------------------------------------------------------------------------

local CHECKER, CARPET = T(11, 5), T(2, 2)

local castle_legend = {
  ['.'] = { tile = T(0, 2), walk = true },
  ['d'] = { tile = T(0, 12), walk = true },
  ['#'] = { tile = T(2, 3), opaque = true },
  ['M'] = { tile = T(11, 0), opaque = true },
  ['P'] = { tile = T(11, 1), opaque = true },
  ['H'] = { tile = T(11, 2), opaque = true },
  ['Y'] = { tile = T(11, 4), opaque = true },
  [':'] = { tile = CHECKER, walk = true },
  ['r'] = { tile = T(11, 6), walk = true },
  ['R'] = { tile = CARPET, walk = true },
  ['_'] = { tile = WOOD, walk = true },
  ['+'] = { tile = T(2, 8), opaque = true, door = '/' },
  ['/'] = { tile = T(2, 9), walk = true },
  ['D'] = { tile = T(11, 9), opaque = true, door = 'A' },
  ['A'] = { tile = T(11, 8), walk = true },
  ['X'] = { tile = T(3, 8), base = CARPET, block = 'The throne of Aldermoor.' },
  ['f'] = { tile = T(11, 12), base = CHECKER, block = 'The brazier is hot.' },
  ['a'] = { tile = T(11, 10), base = CHECKER, block = 'A suit of armour, polished bright.' },
  ['w'] = { tile = T(11, 11), base = CHECKER, block = 'Swords and axes, racked and oiled.' },
  ['T'] = { tile = T(11, 13), base = CHECKER, block = 'The table is laid for a feast.' },
  ['E'] = { tile = T(11, 14), base = WOOD, block = "The king's own bed." },
  ['s'] = { tile = T(11, 15), base = WOOD, block = 'Sacks of grain.' },
  ['k'] = { tile = T(3, 7), base = WOOD, block = 'Histories of the realm.' },
  ['t'] = { tile = T(3, 4), base = WOOD },
  ['h'] = { tile = T(3, 5), base = WOOD },
  ['b'] = { tile = T(3, 2), base = WOOD, block = 'A barrel of cider.' },
  ['c'] = { tile = T(3, 3), base = WOOD, block = 'A crate, nailed shut.' },
}

atlas.castle = {
  title = 'The Castle',
  outside = '.',
  edge_exit = true,
  legend = castle_legend,
  spawn = {
    ['@'] = { kind = 'start', floor = 'd' },
    ['$'] = { kind = 'chest', floor = '_', sprite = T(3, 0), loot = { gold = 25 } },
    ['1'] = {
      kind = 'npc', floor = 'r', sprite = T(4, 12), name = 'King Osric',
      talk = function(game)
        if game.quest == 'done' then
          return 'Aldermoor is in your debt, hero.'
        end
        if game.sunstone then
          game.sunstone = false
          game.quest = 'done'
          game.gold = game.gold + 200
          return 'The Sunstone! You have saved the realm. Take two hundred gold, and my thanks.'
        end
        game.quest = 'given'
        return 'Creatures of Gloomdeep stole the Sunstone. The cave lies east, in the mountains. Bring it home!'
      end,
    },
    ['2'] = {
      kind = 'npc', floor = ':', sprite = T(4, 13), name = 'Queen Maud',
      lines = {
        'Brightwater lies south, down the road and over the bridge. Its healer is kind.',
        'Take what you find in the storeroom. You will need it.',
      },
    },
    ['3'] = { kind = 'npc', floor = ':', sprite = T(4, 11), name = 'Guard',
              lines = { 'Stand straight before the king.' } },
    ['4'] = { kind = 'npc', floor = ':', sprite = T(4, 11), name = 'Guard',
              lines = { 'All quiet.' } },
    ['5'] = {
      kind = 'npc', floor = ':', sprite = T(4, 2), name = 'Wizard', wander = 3,
      lines = {
        'The gates answer to the moons. Watch the sky above your map.',
        'Press P to drink a potion. Space lets a moment pass.',
      },
    },
    ['6'] = {
      kind = 'npc', floor = ':', sprite = T(4, 15), name = 'Smith',
      lines = { 'Bump a foe to strike it. It is not subtle, but it works.' },
    },
    ['7'] = { kind = 'npc', floor = '.', sprite = T(4, 11), name = 'Guard',
              lines = { 'The king awaits you inside.' } },
    ['8'] = { kind = 'npc', floor = '.', sprite = T(4, 11), name = 'Guard',
              lines = { 'Push the great door. It is not barred.' } },
  },
  rows = {
    '.........................',
    '.MMMMMMMMMMMMMMMMMMMMMMM.',
    '.######PHPYYYPHP########.',
    '.#kk_k#f::RXR::f#E____$#.',
    '.#____#:::21::::#______#.',
    '.#_t__+::::r::::+______#.',
    '.#k___#3:::r:::4#__t_h_#.',
    '.######a:::r:::a########.',
    '.#ss__#::::r::::#w:::w:#.',
    '.#s__$+::5:r::::+::6:::#.',
    '.#bb_c#::::r::::#a:w:a:#.',
    '.######YH##A##HY########.',
    '.#f::::::::r::::::::::f#.',
    '.#::TTT::::r::::TTT::::#.',
    '.#:::::::::r:::::::::::#.',
    '.MMMMMMMMMMDMMMMMMMMMMMM.',
    '........7..d..8..........',
    '...........d.............',
    '...........@.............',
  },
}

---------------------------------------------------------------------------
-- Gloomdeep, a cave
---------------------------------------------------------------------------

local DARK = T(12, 4)

local cave_legend = {
  ['#'] = { tile = T(12, 0), opaque = true },
  ['c'] = { tile = T(12, 1), opaque = true },
  ['*'] = { tile = T(2, 5), opaque = true },
  ['.'] = { tile = DARK, walk = true },
  [','] = { tile = T(12, 5), walk = true },
  ['o'] = { tile = T(12, 6), block = 'A pit. You cannot see the bottom.' },
  ['~'] = { tile = T(12, 11), block = 'Black water, cold and still.' },
  ['m'] = { tile = T(12, 10), walk = true },
  ['w'] = { tile = T(12, 12), base = DARK, walk = true },
  ['r'] = { tile = T(12, 13), base = DARK, block = 'A fallen rock.' },
  ['s'] = { tile = T(12, 15), base = DARK, walk = true, note = 'Old bones crunch underfoot.' },
  ['<'] = { tile = T(2, 12), walk = true, exit = true },
  ['L'] = { tile = T(2, 10), opaque = true, door = '/', locked = true },
  ['/'] = { tile = T(2, 9), walk = true },
}

local function monster(sprite, name, hp, damage)
  return { kind = 'monster', floor = '.', sprite = sprite, name = name, hp = hp, damage = damage or 1 }
end

atlas.cave = {
  title = 'Gloomdeep',
  outside = '#',
  light = 4,
  legend = cave_legend,
  spawn = {
    ['@'] = { kind = 'start', floor = '.' },
    ['$'] = { kind = 'chest', floor = '.', sprite = T(3, 0), loot = { gold = 30 } },
    ['p'] = { kind = 'chest', floor = '.', sprite = T(3, 0), loot = { potions = 2 } },
    ['K'] = { kind = 'chest', floor = '.', sprite = T(3, 0), loot = { keys = 1 } },
    ['G'] = { kind = 'chest', floor = '.', sprite = T(3, 0), loot = { sunstone = true } },
    ['R'] = monster(T(5, 6), 'rat', 2),
    ['B'] = monster(T(5, 7), 'bat', 2),
    ['S'] = monster(T(5, 5), 'slime', 3),
    ['X'] = monster(T(5, 8), 'spider', 3),
    ['g'] = monster(T(5, 0), 'goblin', 4),
    ['Z'] = monster(T(5, 2), 'skeleton', 4),
    ['O'] = monster(T(5, 1), 'orc chief', 8, 2),
  },
  rows = {
    '##############################',
    '###...K..#####......####....##',
    '##..g......###..w....*#..O...#',
    '##.....g...##.....o...#..m.G.#',
    '###..s....###.........#......#',
    '####.###*#####...~~...###L####',
    '####.#########..~~~~....#.####',
    '###......####....~~..,..#....#',
    '##..R......................B.#',
    '##.....,..###......S.....###.#',
    '###...#####*####.......###...#',
    '####.#######..####.#####...$.#',
    '####.####.......##.####.....##',
    '###...###...X...##...#########',
    '##..s..##.......###...,.....##',
    '##.....####.######*###..~~..##',
    '##..$..####.#######.....~~...#',
    '###...#####..........Z......##',
    '###########.####@#####...p..##',
    '###########.....<...##########',
    '##############################',
  },
}

return atlas
