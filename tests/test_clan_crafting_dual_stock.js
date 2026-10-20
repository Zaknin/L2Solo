// Warehouse dual-sword blades count only where dual-recipe craft requirements are
// counted; the gear planner never sees them as the member's own gear.
const assert = require('assert');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Policy = require('../src/GameServer/Clan/ClanCraftingPolicy');
const Demand = require('../src/GameServer/Clan/ClanRosterDemand');
const Planner = invoke('GameServer/Clan/ClanEquipmentPlanner');
const DualSwords = invoke('GameServer/Items/C4DualSwordCombinations');
const Recipes = invoke('GameServer/Items/C4RecipeItems');

const recipe = DualSwords.resolveByProductId(2566);
assert(recipe, 'dual sword recipe 2566');
const item = selfId => DataCache.items.find(entry => entry.selfId === selfId);
const rowFor = (selfId, extra = {}) => ({ selfId, kind: item(selfId).template.kind, name: item(selfId).template.name,
    amount: 1, reservedAmount: 0, ...extra });
const owned = { 75: { selfId: 75, amount: 1 } };
const warehouseRow = rowFor(72);

// Gear stock: a warehouse blade stays out, as before.
assert.strictEqual(Policy.stockInventory(owned, [warehouseRow])[72], undefined);
// Craft stock: the blade counts, reserved copies stay out, other weapons stay ignored.
const craft = Policy.craftStock(owned, [warehouseRow]);
assert.strictEqual(craft[72]?.amount, 1);
assert.strictEqual(craft[75].amount, 1);
assert.strictEqual(Policy.craftStock({}, [rowFor(72, { amount: 2, reservedAmount: 1 })])[72].amount, 1);
const stranger = DataCache.items.find(entry => String(entry.template?.kind).startsWith('Weapon')
    && !DualSwords.COMBINATIONS.some(([, left, right]) => left === entry.selfId || right === entry.selfId));
assert(stranger, 'a weapon outside the dual combinations');
assert.strictEqual(Policy.craftStock({}, [rowFor(stranger.selfId)])[stranger.selfId], undefined);

// The handoff still moves the warehouse blade.
assert.deepStrictEqual(Policy.warehouseMaterials({ recipeId: recipe.recipeId }, owned, [warehouseRow]), [{ selfId: 72, amount: 1 }]);

// Dual-craft requirements see the warehouse blade: its own dwarven recipe is not asked for.
const bladeRecipe = Recipes.resolveByProductId(72);
assert(bladeRecipe, 'blade 72 has a dwarven recipe');
const member = { characterId: 1, inventory: owned };
const without = Demand.recipeIds({ recipeId: recipe.recipeId }, member, []);
const withBlade = Demand.recipeIds({ recipeId: recipe.recipeId }, member, [warehouseRow]);
assert(without.includes(Number(bladeRecipe.recipeId)), 'a missing blade asks for its recipe');
assert(!withBlade.includes(Number(bladeRecipe.recipeId)), 'a warehouse blade covers the dual craft');
assert(withBlade.includes(Number(recipe.recipeId)));

// Gear selection is the same with or without a warehouse blade.
const summary = plan => plan ? [plan.status, plan.strategy, plan.target?.selfId, plan.reason || '', plan.recipeId || ''].join('/') : String(plan);
const components = [...new Set(DualSwords.COMBINATIONS.flatMap(([, left, right]) => [left, right]))];
let cases = 0;
for (const [classId, level] of [[4, 22], [4, 30], [2, 45], [88, 50], [5, 45], [31, 30]]) {
    const state = { characterId: 1, name: 'M', level, classId, adena: 5000000, phase: 'cold', inventory: {}, stats: { classId, clanId: 9 } };
    const base = summary(Planner.planForMember(state, [], [], {}));
    for (const selfId of components) {
        assert.strictEqual(summary(Planner.planForMember(state, [], [rowFor(selfId)], {})), base,
            `class ${classId} level ${level} warehouse ${selfId}`);
        cases += 1;
    }
}
assert.strictEqual(cases, 6 * components.length);

console.log('Clan crafting dual stock test passed.');
