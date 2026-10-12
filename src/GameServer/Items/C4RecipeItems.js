const fs = require('fs');

const RECIPE_DATA_PATH = 'data/Recipes/recipes.csv';

let recipeItems = null;
let recipesById = null;
let recipesByProductId = null;
let recipeSource = null;

function parseItemList(value) {
    const items = [];
    String(value || '').replace(/\[(\d+)\((\d+)\)\]/g, (match, selfId, amount) => {
        items.push({
            selfId: Number(selfId),
            amount: Number(amount)
        });
        return match;
    });
    return items;
}

function parseLine(line) {
    const parts = String(line || '').trim().split(';');
    if (parts.length < 11 || !parts[0]) {
        return null;
    }

    const type = parts[0] === 'dwarven' ? 'dwarven' : 'common';
    return {
        type,
        recipeId: Number(parts[2]),
        recipeItemId: Number(parts[3]),
        level: Number(parts[4]),
        materials: parseItemList(parts[5]),
        productId: Number(parts[6]),
        productCount: Number(parts[7]),
        npcFee: parseItemList(parts[8]),
        mpCost: Number(parts[9]),
        successRate: Number(parts[10])
    };
}

function loadRecipeItems() {
    if (recipeItems) {
        return recipeItems;
    }

    recipeItems = {};
    recipesById = {};
    recipesByProductId = {};
    const rows = fs.existsSync(RECIPE_DATA_PATH) ? fs.readFileSync(RECIPE_DATA_PATH, 'utf8')
        .split(/\r?\n/)
        .map(parseLine)
        .filter(Boolean) : [];
    rows.forEach((recipe) => {
        if (!recipeItems[recipe.recipeItemId]) {
            recipeItems[recipe.recipeItemId] = recipe;
        }
        if (!recipesById[recipe.recipeId]) {
            recipesById[recipe.recipeId] = recipe;
        }
        if (!recipesByProductId[recipe.productId]) {
            recipesByProductId[recipe.productId] = recipe;
        }
    });

    // One loaded CSV source per process. Its row-array identity is the
    // source revision; there is no timer or live reload. Keep every parsed
    // variant here, while the existing helpers retain their first match.
    // Source data is immutable by agreement for this declared revision.
    // Freeze only this container, never the author's mutable recipe objects.
    const sourceRows = Object.freeze(rows);
    recipeSource = Object.freeze({ revision: sourceRows, rows: sourceRows, recipeItems });

    return recipeItems;
}

function resolve(selfId) {
    return loadRecipeItems()[Number(selfId)] || null;
}

function resolveByRecipeId(recipeId) {
    loadRecipeItems();
    return recipesById[Number(recipeId)] || null;
}

function resolveByProductId(productId) {
    loadRecipeItems();
    return recipesByProductId[Number(productId)] || null;
}

function nativeSource() {
    loadRecipeItems();
    return recipeSource;
}

module.exports = {
    RECIPE_DATA_PATH,
    loadRecipeItems,
    resolve,
    resolveByRecipeId,
    resolveByProductId,
    nativeSource,
    // A synthetic craft query need not load the native CSV just to miss it.
    loadedSource: () => recipeSource
};
