const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');

DataCache.init();

// The published station recipes were computed in five places on every call.
// They now come from one table built per item catalogue; it must describe the
// same recipes and stations as a direct computation from the station layout.
const stationService = { level: 70, stats: { classId: 57 } };
const itemIds = new Set(DataCache.items.map((item) => Number(item.selfId)));
const direct = (craftLevel) => [...new Map(Object.values(C4RecipeItems.loadRecipeItems())
    .filter((recipe) => recipe?.type === 'dwarven' && Number(recipe.level || 0) <= craftLevel
        && itemIds.has(Number(recipe.productId)))
    .map((recipe) => [Number(recipe.recipeId), recipe])).values()]
    .sort((a, b) => Number(a.recipeId) - Number(b.recipeId));

for (const [state, craftLevel] of [[stationService, 9], [{ level: 40, stats: { classId: 56 } }, 4], [{ level: 45, stats: { classId: 57 } }, 5]]) {
    assert.strictEqual(CraftShopService.craftLevelFor(state), craftLevel, 'fixture: craft level');
    assert.deepStrictEqual(CraftShopService.availableRecipes(state).map((recipe) => recipe.recipeId),
        direct(craftLevel).map((recipe) => recipe.recipeId), `craft level ${craftLevel} must see every dwarven recipe up to its level`);
}
assert.deepStrictEqual(CraftShopService.availableRecipes({ level: 70, stats: { classId: 0 } }), [],
    'a non-crafter has no service recipes');

const allowed = direct(9);
const firstStation = new Map();
for (const station of CraftShopService.CraftStations) {
    for (const recipe of CraftShopService.stationRecipes(station, allowed)) {
        if (!firstStation.has(Number(recipe.recipeId))) firstStation.set(Number(recipe.recipeId), station.id);
    }
}
const published = CraftShopService.publishedStationRecipes();
assert(published.recipes.length > 100, 'fixture: the stations publish the progression catalogue');
assert.deepStrictEqual(published.recipes.map((recipe) => Number(recipe.recipeId)), [...firstStation.keys()],
    'every published recipe once, in station order');
assert.deepStrictEqual([...published.ids], [...firstStation.keys()]);
for (const [recipeId, stationId] of firstStation) {
    assert.strictEqual(published.stationByRecipeId.get(recipeId).id, stationId, `recipe ${recipeId} goes to its first station`);
    assert.strictEqual(ColdCraftingService.stationForRecipe(recipeId).id, stationId, `cold crafting routes recipe ${recipeId} to the same station`);
}

assert.strictEqual(CraftShopService.publishedStationRecipes(), published, 'the table is built once per item catalogue');
const template = id => DataCache.items.find(item => Number(item.selfId) === Number(id));
const bWeaponRecipes = allowed.filter(recipe => recipe.successRate === 100
    && template(recipe.productId)?.etc?.rank === 'b'
    && template(recipe.productId)?.template?.kind.startsWith('Weapon.'));
assert.strictEqual(bWeaponRecipes.length, 19, 'native B weapons include physical and caster blunts');
for (const recipe of bWeaponRecipes) {
    const station = published.stationByRecipeId.get(recipe.recipeId);
    assert(station?.id === 'b_weapons' || station?.id === 'b_weapons_entry',
        `${template(recipe.productId).template.name} must have a published B weapon station`);
}
assert.strictEqual(CraftShopService.CraftStations[13].id, 'b_weapons', 'existing B crafter account keeps its station');
assert.strictEqual(CraftShopService.CraftStations[31].id, 'b_weapons_entry', 'the entry station is appended after existing accounts');
const entry = CraftShopService.profileFor({ level: 70, accountName: 'bot_craft_32', stats: { classId: 57 } });
assert.strictEqual(entry.stationId, 'b_weapons_entry');
assert(entry.entries.some(row => row.recipeId === 457), 'the new station publishes Great Axe');
assert(entry.entries.some(row => row.recipeId === 441), 'the new station publishes Heavy War Axe');
assert(entry.entries.length <= CraftShopService.MAX_PUBLIC_RECIPES, 'the native public recipe limit is respected');
const originalItems = DataCache.items;
DataCache.items = originalItems.filter((item) => Number(item.selfId) !== Number(published.recipes[0].productId));
try {
    assert(!CraftShopService.publishedStationRecipes().ids.has(Number(published.recipes[0].recipeId)),
        'a changed item catalogue rebuilds the table');
} finally {
    DataCache.items = originalItems;
}

// Station crafters are seeded at the content cap; the stations publish only
// what such a crafter makes, and the full catalogue at the maximum cap.
assert.deepStrictEqual(CraftShopService.stationCrafter(), { classId: 57, level: 70 });
const progression = options.default.Progression;
options.default.Progression = { ...(progression || {}), contentCap: 52 };
try {
    assert.deepStrictEqual(CraftShopService.stationCrafter(), { classId: 57, level: 52 });
    const cappedFirst = new Map();
    for (const station of CraftShopService.CraftStations) {
        for (const recipe of CraftShopService.stationRecipes(station, direct(6))) {
            if (!cappedFirst.has(Number(recipe.recipeId))) cappedFirst.set(Number(recipe.recipeId), station.id);
        }
    }
    const capped = CraftShopService.publishedStationRecipes();
    assert.deepStrictEqual(capped.recipes.map((recipe) => Number(recipe.recipeId)), [...cappedFirst.keys()],
        'a capped world publishes what a capped station crafter (craft level 6) makes');
    assert(capped.recipes.length < published.recipes.length, 'fixture: the cap removes recipes');
} finally {
    if (progression === undefined) delete options.default.Progression;
    else options.default.Progression = progression;
}
assert.deepStrictEqual(CraftShopService.publishedStationRecipes().recipes.map((recipe) => Number(recipe.recipeId)),
    [...firstStation.keys()], 'the maximum cap publishes the full catalogue again');
console.log('Craft station catalogue checks passed');
