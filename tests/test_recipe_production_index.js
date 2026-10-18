'use strict';
const assert = require('node:assert/strict');
const recipes = [
    { type: 'dwarven', recipeId: 1, recipeItemId: 101, productId: 201, level: 2 },
    { type: 'dwarven', recipeId: 2, recipeItemId: 102, productId: 202, level: 5 },
    { type: 'dwarven', recipeId: 3, recipeItemId: 103, productId: 201, level: 3 },
    { type: 'common', recipeId: 4, recipeItemId: 104, productId: 204, level: 1 },
    { type: 'dwarven', recipeId: 5, recipeItemId: 105, productId: 205, level: 10 }
];
global.invoke = name => {
    assert.equal(name, 'GameServer/Items/C4RecipeItems');
    return { loadRecipeItems: () => recipes };
};
// Synthetic recipes have independently supplied origin permission.
const Catalog = require('../src/GameServer/Items/ItemAcquisitionCatalog');
const nativeAdmission = Catalog.allowsRecipe;
Catalog.allowsRecipe = recipe => recipes.includes(recipe);
const { forBoard } = require('../src/GameServer/Bot/Economy/RecipeProductionIndex');
const quotes = new Map();
const board = { list: (id, side) => quotes.get(`${id}:${side}`) || [] };
const ids = (index, level) => [...index.rowsFor(level)].map(recipe => recipe.recipeId).sort();
const index = forBoard(board);
assert.strictEqual(forBoard(board), index, 'one index per board lifetime');
assert.deepEqual(ids(index, 9), []);
quotes.set('101:1', [{ price: 20, count: 1 }]);
assert.deepEqual(index.update(101), [], 'offered recipe alone is not product demand');
quotes.set('201:3', [{ price: 100, count: 1 }]);
assert.deepEqual(index.update(201), Array.from({ length: 8 }, (_, at) => index.scopeFor(at + 2)));
assert.deepEqual(ids(index, 1), []); assert.deepEqual(ids(index, 2), [1]);
assert.deepEqual(ids(index, 3), [1, 3], 'public product demand admits recipes without a scroll SELL');
const revision = index.revision(index.scopeFor(9));
quotes.set('101:1', [{ price: 30, count: 3 }]);
assert.deepEqual(index.update(101), []);
assert.equal(index.revision(index.scopeFor(9)), revision, 'price/count changes are ordinary item dependencies');
assert.deepEqual(index.update(999), []);
quotes.set('103:1', [{ price: 30, count: 1 }]); index.update(103);
assert.deepEqual(ids(index, 2), [1]); assert.deepEqual(ids(index, 3), [1, 3]);
quotes.set('102:1', [{}]); quotes.set('202:3', [{}]); index.update(102);
assert.deepEqual(ids(index, 4), [1, 3]); assert.deepEqual(ids(index, 5), [1, 2, 3]);
quotes.delete('201:3'); index.update(201);
assert.deepEqual(ids(index, 5), [2], 'product disappearance removes every reverse-indexed recipe');
quotes.delete('102:1'); index.update(102); assert.deepEqual(ids(index, 9), [2], 'missing scroll supply preserves preparatory product demand');
quotes.delete('202:3'); index.update(202); assert.deepEqual(ids(index, 9), []);
quotes.set('104:1', [{}]); quotes.set('204:3', [{}]); quotes.set('105:1', [{}]); quotes.set('205:3', [{}]);
index.update(104); index.update(105); assert.deepEqual(ids(index, 9), [], 'common/out-of-skill recipes stay excluded');
const staticBoard = { list: (id, side) => id === 101 && side === 1 ? [{}] : [] };
assert.deepEqual(ids(forBoard(staticBoard, { fixedBuyer: recipe => recipe.productId === 201 }), 2), [1]);
const fixedIndex = forBoard(staticBoard);
fixedIndex.reset();
assert.deepEqual(ids(fixedIndex, 2), [1], 'replacement keeps fixed demand even without any public product row');
const initialRevision = index.revision(index.scopeFor(9));
quotes.set('101:1', [{}]); quotes.set('201:3', [{}]); index.update(101);
assert(index.reset().includes(index.scopeFor(9)));
assert.deepEqual(ids(index, 9), []); assert(index.revision(index.scopeFor(9)) > initialRevision);
index.update(101); assert.deepEqual(ids(index, 2), [1], 'snapshot replacement repopulates incrementally');
console.log('PASS public recipe admission, skill bounds, reverse removal, membership-only revisions and fixed buyer');

Catalog.allowsRecipe = nativeAdmission;

// The shared graph indexes the declared native source at first build,
// independently of production admission and the first-product resolver.
const NativeRecipes = require('../src/GameServer/Items/C4RecipeItems');
const Knowledge = require('../src/GameServer/Knowledge/RecipeCatalog');
const GameCatalogue = require('../src/GameServer/Knowledge/GameDataCatalogue').native();
const source = NativeRecipes.nativeSource(), expectedByIngredient = new Map(), products = new Map();
const early = source.rows.find(recipe => recipe.materials.length), originalEarlyAmount = early.materials[0].amount;
let declaredEarlyInputs;
try {
    // Source objects are mutable: an edit before lazy construction is what
    // that revision's public index observes. It is not a clone of CSV bytes.
    early.materials[0].amount++;
    declaredEarlyInputs = early.materials.map(input => ({ selfId: input.selfId, amount: input.amount }));
    Knowledge.warmup();
} finally { early.materials[0].amount = originalEarlyAmount; }
assert.equal(Knowledge.revision(), source.revision, 'an undeclared in-place edit does not replace the source revision');
assert.equal(Knowledge.inputsFor(early), null, 'restored raw values differ from the preparation first observed');
let orderedInputs = 0, normalizedIngredients = 0;
assert.deepEqual(Knowledge.recipeItemRows(), Object.values(NativeRecipes.loadRecipeItems()), 'production keeps existing source ordering');
for (const recipe of source.rows) {
    if (!products.has(recipe.productId)) products.set(recipe.productId, []);
    products.get(recipe.productId).push(recipe);
    const totals = new Map();
    for (const input of recipe === early ? declaredEarlyInputs : recipe.materials) {
        assert(Number.isSafeInteger(input.selfId) && input.selfId > 0 && Number.isSafeInteger(input.amount) && input.amount > 0);
        totals.set(input.selfId, (totals.get(input.selfId) || 0) + input.amount);
        orderedInputs++;
    }
    for (const [selfId, quantity] of totals) {
        if (!expectedByIngredient.has(selfId)) expectedByIngredient.set(selfId, []);
        expectedByIngredient.get(selfId).push({ selfId, recipeId: recipe.recipeId, quantity });
        normalizedIngredients++;
    }
}
for (const [selfId, expected] of expectedByIngredient) assert.deepEqual(Knowledge.recipesUsing(String(selfId)), expected);
assert(source.rows.some(recipe => recipe.type === 'common'), 'native knowledge retains common recipes');
assert([...products.values()].some(recipes => recipes.length > 1), 'native data includes alternate recipes for a product');
for (const variants of products.values()) {
    assert.equal(NativeRecipes.resolveByProductId(variants[0].productId), variants[0], 'first-product helper remains unchanged');
    assert(variants.every(recipe => Knowledge.rows().includes(recipe)), 'shared knowledge retains every native variant');
    assert.deepEqual(GameCatalogue.recipesForProduct(variants[0].productId), variants, 'the public product graph preserves all native variants/order');
    assert.equal(GameCatalogue.recipe(variants[0].recipeId), NativeRecipes.resolveByRecipeId(variants[0].recipeId));
}
for (const [id] of expectedByIngredient) assert.equal(GameCatalogue.recipesUsing(id), Knowledge.recipesUsing(id), 'public reverse reuses the same owner rows');
const graphRecipe = source.rows.find(recipe => recipe.materials.length);
assert.equal(GameCatalogue.ingredientsForRecipe(graphRecipe.recipeId), Knowledge.ingredientsForRecipe(graphRecipe.recipeId));
const native = source.rows.find(recipe => recipe !== early && recipe.materials.length), oldAmount = native.materials[0].amount;
const declared = Knowledge.recipesUsing(native.materials[0].selfId);
try {
    native.materials[0].amount = oldAmount + 1;
    assert.equal(Knowledge.inputsFor(native), null, 'author object mutation is not reused as native preparation');
    assert.equal(Knowledge.recipesUsing(native.materials[0].selfId), declared, 'public reverse remains the declared first-build data');
} finally { native.materials[0].amount = oldAmount; }
console.log(JSON.stringify({ nativeRecipeRows: source.rows.length, orderedInputs, normalizedIngredients,
    ingredientKeys: expectedByIngredient.size, orderedAuthorInputReferences: orderedInputs,
    ingredientReferences: normalizedIngredients * 2, productKeys: products.size, productReferences: source.rows.length, perBotRetainedBytes: 0 }));
