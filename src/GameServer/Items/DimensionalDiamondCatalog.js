'use strict';

const data = require('../../../data/Items/dimensional_diamond_exchanges.json');
const currentIndex = require('../Knowledge/NativeServiceIndex').currentIndex;
const recipeIndex = currentIndex(['itemId'], rows => {
    const byItem = new Map();
    for (const row of rows) if (!byItem.has(row.itemId)) byItem.set(row.itemId, row);
    return byItem;
});
const npcIndex = currentIndex([], rows => new Set(rows));
function recipe(itemId) {
    const index = recipeIndex(data.recipes);
    return index ? Number.isNaN(itemId) ? undefined : index.get(itemId)
        : data.recipes.find(row => row.itemId === itemId);
}
function hasNpc(npcId) {
    const index = npcIndex(data.npcs);
    return index ? index.has(npcId) : data.npcs.includes(npcId);
}
function hasRecipe(itemId) {
    const index = recipeIndex(data.recipes);
    return index ? !Number.isNaN(itemId) && index.has(itemId)
        : data.recipes.some(row => row.itemId === itemId);
}
module.exports = { data, recipe, hasRecipe, hasNpc };
