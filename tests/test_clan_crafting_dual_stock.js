// Warehouse dual-sword components count in the planner stock like in the handoff.
const assert = require('assert');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Policy = require('../src/GameServer/Clan/ClanCraftingPolicy');
const DualSwords = invoke('GameServer/Items/C4DualSwordCombinations');

const recipe = DualSwords.resolveByProductId(2566);
assert(recipe, 'dual sword recipe 2566');
const kindOf = selfId => DataCache.items.find(item => item.selfId === selfId).template.kind;
const owned = { 75: { selfId: 75, amount: 1 } };
const warehouseRow = { selfId: 72, kind: kindOf(72), amount: 1, reservedAmount: 0 };

const pooled = Policy.stockInventory(owned, [warehouseRow]);
const handoff = Policy.warehouseMaterials({ recipeId: recipe.recipeId }, owned, [warehouseRow]);
assert.strictEqual(handoff.length, 1);
assert.strictEqual(handoff[0].selfId, 72);
assert.strictEqual(handoff[0].amount, 1);
// The handoff moves the blade, so the planner must count it as clan stock too.
assert.strictEqual(pooled[72]?.amount, 1);
assert.strictEqual(pooled[75].amount, 1);

// Reserved copies stay out, and a plain weapon that is no component stays ignored.
const reserved = Policy.stockInventory({}, [{ ...warehouseRow, amount: 2, reservedAmount: 1 }]);
assert.strictEqual(reserved[72].amount, 1);
const stranger = DataCache.items.find(item => String(item.template?.kind).startsWith('Weapon')
    && !DualSwords.COMBINATIONS.some(([, left, right]) => left === item.selfId || right === item.selfId));
assert(stranger, 'a weapon outside the dual combinations');
assert.strictEqual(Policy.stockInventory({}, [{ selfId: stranger.selfId, kind: stranger.template.kind, amount: 1 }])[stranger.selfId], undefined);

console.log('Clan crafting dual stock test passed.');
