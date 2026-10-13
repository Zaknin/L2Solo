'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Starter = require('../src/GameServer/Knowledge/StarterItemCatalog');
const Crystals = require('../src/GameServer/Knowledge/CrystalCatalog');
const Recovery = require('../src/GameServer/Knowledge/RecoveryCatalog');
const Recipes = require('../src/GameServer/Knowledge/RecipeCatalog');
const Gear = invoke('GameServer/Bot/AI/BotGear');

const source = [
    { classId: '1', items: [{ selfId: '9', equipped: true }] },
    { classId: 1, items: [{ selfId: '2', equipped: true }, { selfId: 3, equipped: 1 }, { selfId: 4 }] },
    { classId: 1, items: [{ selfId: 5, equipped: true }] }
];
assert.deepEqual([...Starter.ids(source)], [9, 2, 3, 4, 5]);
assert.deepEqual([...Starter.importIds(source)], [9, 2, 3, 4, 5]);
assert.throws(() => Starter.importIds([{}]), TypeError, 'import source retains required items arrays');
assert.deepEqual([...Starter.ids(source, true)], [9, 2, 3, 5]);
assert.deepEqual([...Starter.ids(source, 'strict', 1)], [2]);
assert.strictEqual(Starter.grants(source, 1), source[1].items, 'strict FIRST class and raw grant order');
const observer = {}, initial = Starter.snapshotIds(source, observer);
source[1].items.push({ selfId: 6, equipped: true });
assert.strictEqual(Starter.snapshotIds(source, observer), initial);
assert(!initial.has(6), 'identity-only grants keep the original snapshot');
assert(Starter.ids(source, 'strict', 1).has(6), 'current class grants observe same-array edits');
Starter.snapshotIds([], observer);
assert(Starter.snapshotIds(source, observer).has(6), 'A -> B -> A starts a new snapshot');

function item(id, slot, rank, score = 1, price = 10, kind = 'Weapon.Sword') {
    return { selfId: id, template: { kind, price, name: `Item ${id}` },
        etc: { slot, rank, cristals: 2 }, stats: { pAtk: score } };
}
const items = [item(4, 7, 'd', 1, 10), item(3, 7, 'd', 1, 9), item(2, 7, 'd', 2, 50),
    item(3, 7, 'none', 1, 9), item(8, 14, 'd'), item(9, 1, 'd', 1, 10, 'Armor.Jewel')];
assert.deepEqual(Gear.currentRankRows(items, 'd'), items.filter(row => row.etc.rank === 'd'));
assert.deepEqual(Gear.currentSlotRows(items, 'weapon'), items.slice(0, 5));
assert.deepEqual(Gear.currentSlotRows(items, 2, true), [items[5]]);
assert.throws(() => Gear.currentSlotRows([null], 7, true), TypeError, 'malformed raw catalog rows remain errors');
const mutable = Gear.currentWearableRows(items); mutable.pop();
assert.equal(Gear.currentWearableRows(items).length, items.length, 'fresh views belong to the caller');
items[0].etc.slot = 0; items[0].etc.rank = 'none';
assert(!Gear.currentWearableRows(items).includes(items[0]));
assert(Gear.currentRankRows(items, 'none').includes(items[0]), 'nested edits are visible without a revision');
let loads = 0;
const shops = { allEntries: () => { loads++; return loads === 1 ? [] : [{ selfId: 3 }]; } };
assert.deepEqual(Gear.currentNpcRows(items, shops), []);
assert.deepEqual(Gear.currentNpcRows(items, shops), [items[1], items[3]]);
items.push(item(3, 7, 'd'));
assert.deepEqual(Gear.currentNpcRows(items, { allEntries: () => { throw Error('snapshot reloaded'); } }),
    [items[1], items[3], items[6]], 'NPC keys retain startup admission; rows stay current and ordered');

const Planner = { suitable: () => true, itemScore: row => row.stats.pAtk };
const Sources = { hasSource: () => true };
const kits = Gear.wishKitsFor(items, 1, 991, 'test', Planner, Sources);
const column = kits.get(7);
assert.deepEqual(Array.from({ length: column.length }, (_, at) => column.itemAt(at)), [items[2], items[1], items[3], items[6]]);
assert(Object.isFrozen(kits)); assert(Object.isFrozen(column));
assert.equal(kits.set, undefined); assert.equal(column.items, undefined);
assert.equal(column.scores, undefined); assert.equal(column.ranks, undefined);
assert.throws(() => { column.length = 0; }, TypeError, 'derived kit metadata stays owned');
const callerSlots = new Map(kits); callerSlots.clear();
assert.strictEqual(kits.get(7), column, 'mutable caller slot overlays do not edit the private map');
items[1].stats.pAtk = 100;
assert.strictEqual(Gear.wishKitsFor(items, 1, 991, 'test', Planner, Sources), kits);
assert.equal(kits.get(7).scoreAt(1), 1, 'revisioned columns retain first observed scores');
assert.equal(Gear.wishKitsFor(items, 2, 991, 'test', Planner, Sources).get(7).scoreAt(0), 100);
Gear.wishKitsFor([], 2, 991, 'test', Planner, Sources);
assert.equal(Gear.wishKitsFor(items, 2, 991, 'test', Planner, Sources).get(7).scoreAt(0), 100);

const crystalItems = [item(21, 7, 'D'), item(22, 0, 'D', 1, 10, 'Other.Material'), item(21, 7, 'D')];
const cold = Crystals.coldGearByRank(crystalItems);
assert.deepEqual(cold.get('D').map(row => row.selfId), [21, 21], 'cold admits only gear, preserving duplicates/order');
assert.deepEqual([...Crystals.facts(crystalItems)].map(row => row.gear), crystalItems, 'first-price sees broader raw facts');
crystalItems[0].etc.cristals = 99;
assert.equal(cold.get('D')[0].crystals, 2, 'cold crystal count remains a frozen startup observation');
assert.equal([...Crystals.facts(crystalItems)][0].crystals, 99);
const partialCrystals = new Map(), seen = [];
assert.throws(() => Crystals.coldGearByRank(crystalItems, row => {
    seen.push(row.selfId); if (seen.length === 2) throw Error('counter failure');
}, partialCrystals), /counter failure/);
assert.deepEqual(partialCrystals.get('D').map(row => row.selfId), [21],
    'counter calls and partial startup rows retain original order on failure');
const rates = Recovery.seatedMpRates([{ classId: '2' }, { classId: 2 }],
    { coldRestRegenPerTick: ({ level }) => ({ mp: level / 1200 }) });
assert(rates.get(2) instanceof Float64Array); assert.equal(rates.get(2).length, 81);
assert.equal(rates.get(2)[0], 0); assert.equal(rates.get(2)[80], 80);

const partialRates = new Map();
assert.throws(() => Recovery.seatedMpRates([{ classId: 1 }, { classId: 2 }], {
    coldRestRegenPerTick: ({ stats }) => { if (stats.classId === 2) throw Error('rest failure'); return { mp: 1 }; }
}, partialRates), /rest failure/);
assert.deepEqual([...partialRates.keys()], [1], 'completed startup class tables survive a later failure');

const scrolls = { 8: { type: 'dwarven', productId: '3', successRate: 80, recipeId: 2 },
    4: { type: 'common', productId: 3 }, 5: { type: 'dwarven', productId: 3, recipeId: 1 } };
const recipeOwner = { loadRecipeItems: () => scrolls };
assert.deepEqual(Recipes.currentDwarvenScrollRows(recipeOwner, 3), [scrolls[5], scrolls[8]]);
const own = Recipes.currentDwarvenScrollRows(recipeOwner); own.length = 0;
scrolls[4].type = 'dwarven';
assert.deepEqual(Recipes.currentDwarvenScrollRows(recipeOwner, '3'), Object.values(scrolls));
assert.deepEqual(Recipes.currentDwarvenScrollRows(recipeOwner, NaN), [], 'numeric equality never matches NaN');

const Data = invoke('GameServer/DataCache'); Data.init();
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const originalNewbieItems = Data.newbieItems;
const starterItem = selfId => ({ selfId, kind: 'Weapon.Sword' });
const starterTemplate = { template: { kind: 'Weapon.Sword' } };
try {
    const firstBad = [{ items: [null] }];
    Data.newbieItems = firstBad;
    assert.throws(() => Disposition.isStarterEquipment(starterItem(910001), starterTemplate), TypeError);
    assert.equal(Disposition.isStarterEquipment(starterItem(910001), starterTemplate), false,
        'first failed source retains the initial empty starter IDs and does not retry');
    const sourceA = [{ items: [{ selfId: 910001 }] }];
    Data.newbieItems = sourceA;
    assert.equal(Disposition.isStarterEquipment(starterItem(910001), starterTemplate), true);
    sourceA[0].items.push({ selfId: 910002 });
    assert.equal(Disposition.isStarterEquipment(starterItem(910002), starterTemplate), false);
    Data.newbieItems = [{ items: [null] }];
    assert.throws(() => Disposition.isStarterEquipment(starterItem(910002), starterTemplate), TypeError);
    assert.equal(Disposition.isStarterEquipment(starterItem(910001), starterTemplate), true,
        'same failed B source returns prior A IDs after publishing B before construction');
    assert.equal(Disposition.isStarterEquipment(starterItem(910002), starterTemplate), false);
    Data.newbieItems = sourceA;
    assert.equal(Disposition.isStarterEquipment(starterItem(910002), starterTemplate), true,
        'returning to A after failed B rebuilds and observes the appended grant');
} finally { Data.newbieItems = originalNewbieItems; }
const originalItems = Data.items;
try {
    const first = Gear.planFor({ classId: 0, level: 15 });
    const chosen = first.items.find(row => row.slot === 7 || row.slot === 14);
    const raw = originalItems.find(row => row.selfId === chosen.selfId), originalName = raw.template.name;
    try {
        raw.template.name = 'New observed name';
        assert.deepEqual(Gear.planFor({ classId: 0, level: 15 }), first, 'flattened plan remains identity+length frozen');
        Data.items = [...originalItems]; Gear.planFor({ classId: 0, level: 15 });
        Data.items = originalItems;
        assert.equal(Gear.planFor({ classId: 0, level: 15 }).items.find(row => row.selfId === chosen.selfId).name,
            'New observed name', 'returning to A rebuilds the frozen projection');
    } finally { raw.template.name = originalName; }
    const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
    const published = Shops.publishedStationRecipes().recipes;
    const before = new Map(published.map(row => [Number(row.recipeId), row]));
    const index = Shops.publishedRecipeIndex();
    assert.deepEqual([...index], [...before]); index.clear();
    assert.deepEqual([...Shops.publishedRecipeIndex()], [...before], 'clan overlays cannot edit station stock');
    const savedIds = published.slice(0, 2).map(row => row.recipeId);
    try {
        published[0].recipeId = NaN; published[1].recipeId = 'not-a-number';
        const last = Shops.publishedRecipeIndex();
        assert.equal(last.get(NaN), published[1], 'current published keys use numeric LAST/SameValueZero');
        assert.deepEqual([...last], [...new Map(published.map(row => [Number(row.recipeId), row]))]);
    } finally { published.slice(0, 2).forEach((row, at) => { row.recipeId = savedIds[at]; }); }

} finally { Data.items = originalItems; }
console.log('PASS starter/equipment/crystal/recovery/scroll/published ownership and observation contracts');
