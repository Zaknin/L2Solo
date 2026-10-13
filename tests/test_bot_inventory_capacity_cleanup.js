'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const now = 1791825000000;
const bag = (slots, race = 4, expansion = 0) => ({ characterId: 990010, level: 55,
    phase: 'cold', activity: 'hunting', vitals: { hp: 100, mp: 100 },
    stats: { race, classId: race === 4 ? 55 : 2, marketSellRetryAfter: now + 3600000,
        coldCombat: { classId: race === 4 ? 55 : 2, skillSource: 'native',
            skills: expansion ? [{ selfId: 1372, level: expansion }] : [] } },
    inventory: { 951: { selfId: 951, amount: slots, kind: 'Other.Scroll', stackable: false,
        instances: Array.from({ length: slots }, (_, index) => ({ id: 9900000 + index,
            amount: 1, equipped: false, enchant: 0 })) } } });

assert.equal(Disposition.inventorySlotCount(bag(86)), 86);
assert.equal(Disposition.inventoryCleanupNeed(bag(86), { now }), null,
    '86 of 100 dwarf slots respect the sale cooldown instead of looping through town');
assert.equal(Floor.forState(bag(86), now), null, 'the native survival floor agrees');
assert.equal(Disposition.inventoryCleanupNeed(bag(101), { now })?.limit, 100,
    'actual dwarf overflow bypasses the cooldown');
assert.equal(Floor.forState(bag(100), now)?.reason, 'no_slot', 'a genuinely full dwarf bag still unloads');
assert.equal(Disposition.inventoryCleanupNeed(bag(81, 0), { now })?.limit, 80,
    'ordinary characters retain the native 80-slot limit');
assert.equal(Disposition.inventoryCleanupNeed(bag(101, 4, 1), { now }), null,
    'learned Expand Inventory adds six usable slots');
assert.equal(Floor.forState(bag(101, 4, 1), now), null, 'the native floor counts the expansion too');
assert.equal(Floor.forState(bag(106, 4, 1), now)?.limit, 106);
assert.equal(Disposition.inventoryCleanupNeed(bag(87, 0, 2), { now }), null,
    'ordinary characters also keep their learned expansion');

const items = bag(101).inventory[951].instances;
const actor = { fetchRace: () => 4, fetchMaxLoad: () => 1000000,
    backpack: { fetchItems: () => items, fetchTotalLoad: () => 0 },
    skillset: { fetchSkill: id => id === 1372 ? { fetchLevel: () => 1 } : null } };
assert.equal(Floor.bagMarks(actor).full, 0, 'hot bag flags use the same expanded native limit');
actor.skillset.fetchSkill = () => null;
assert.equal(Floor.bagMarks(actor).full, 1, 'removing the expansion makes the hot bag full');
console.log('test_bot_inventory_capacity_cleanup: ok');
