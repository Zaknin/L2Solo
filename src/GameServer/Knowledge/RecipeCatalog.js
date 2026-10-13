'use strict';

const NativeRecipes = require('../Items/C4RecipeItems');
const EMPTY = Object.freeze([]);
let catalog = null;
let dwarvenCatalog = null;

// Freeze the quantities observed at the first build of a declared source
// revision. Unannounced edits to its mutable author objects are not a public
// catalog revision: craft readers see them through their validation fallback.
function catalogFor(source) {
    if (catalog?.revision === source.revision) return catalog;
    const inputs = new WeakMap(), byIngredient = new Map(), byProduct = new Map();
    for (const recipe of source.rows) {
        const productId = Number(recipe.productId);
        if (!byProduct.has(productId)) byProduct.set(productId, []);
        byProduct.get(productId).push(recipe);
        if (!Array.isArray(recipe.materials)) continue;
        const entries = [], totals = new Map();
        let safe = true;
        for (const input of recipe.materials) {
            const selfId = input.selfId, amount = input.amount;
            if (!Number.isSafeInteger(selfId) || selfId < 1 || !Number.isSafeInteger(amount) || amount < 1) {
                safe = false; break;
            }
            const quantity = (totals.get(selfId) || 0) + amount;
            if (!Number.isSafeInteger(quantity)) { safe = false; break; }
            entries.push(Object.freeze({ input, selfId, amount }));
            totals.set(selfId, quantity);
        }
        if (!safe) continue;
        const ingredients = [];
        for (const [selfId, quantity] of totals) {
            // The prepared totals and the public reverse relation share this
            // same row; consumers never receive another normalized copy.
            const row = Object.freeze({ selfId, recipeId: Number(recipe.recipeId), quantity });
            ingredients.push(row);
            if (!byIngredient.has(selfId)) byIngredient.set(selfId, []);
            byIngredient.get(selfId).push(row);
        }
        inputs.set(recipe, Object.freeze({ entries: Object.freeze(entries), ingredients: Object.freeze(ingredients) }));
    }
    for (const rows of byIngredient.values()) Object.freeze(rows);
    for (const rows of byProduct.values()) Object.freeze(rows);
    catalog = { revision: source.revision, rows: source.rows,
        recipeItemRows: Object.freeze(Object.values(source.recipeItems)), inputs, byIngredient, byProduct };
    return catalog;
}

function rows() { return catalogFor(NativeRecipes.nativeSource()).rows; }
function recipesUsing(selfId) { return catalogFor(NativeRecipes.nativeSource()).byIngredient.get(Number(selfId)) || EMPTY; }
function recipesForProduct(selfId) { return catalogFor(NativeRecipes.nativeSource()).byProduct.get(Number(selfId)) || EMPTY; }
function ingredientsForRecipe(recipeId) {
    const recipe = NativeRecipes.resolveByRecipeId(recipeId);
    return recipe ? catalogFor(NativeRecipes.nativeSource()).inputs.get(recipe)?.ingredients || null : null;
}
function revision() { return NativeRecipes.nativeSource().revision; }
function warmup() { catalogFor(NativeRecipes.nativeSource()); }

// Production retains the old scroll-selected ordering and admission policy.
// An injected synthetic owner has no declared native revision: do not cache it.
function recipeItemRows(owner = NativeRecipes, current = false) {
    if (current) return Object.values(owner.loadRecipeItems());
    return typeof owner.nativeSource === 'function' ? catalogFor(owner.nativeSource()).recipeItemRows
        : Object.values(owner.loadRecipeItems() || {});
}

// These planning readers formerly scanned current scroll-selected rows. Keep
// raw type/product edits visible and caller-owned arrays (including duplicates).
function currentDwarvenScrollRows(owner = NativeRecipes, productId) {
    return recipeItemRows(owner, true).filter(recipe => recipe.type === 'dwarven'
        && (arguments.length < 2 || Number(recipe.productId) === Number(productId)));
}

// Station stock selects recipe-scroll rows, admits only present products,
// and keeps the last numeric recipe-ID variant before sorting by that ID.
// This is separate from first-match recipe/product resolution.
function dwarvenRecipesForItems(items, owner = NativeRecipes) {
    const recipeRows = recipeItemRows(owner);
    if (dwarvenCatalog?.items === items && dwarvenCatalog.itemsLength === items?.length
        && dwarvenCatalog.recipeRows === recipeRows) return dwarvenCatalog.rows;
    const itemIds = new Set((items || EMPTY).map(item => Number(item.selfId))), unique = new Map();
    for (const recipe of recipeRows) {
        if (recipe?.type === 'dwarven' && itemIds.has(Number(recipe.productId))) unique.set(Number(recipe.recipeId), recipe);
    }
    const rows = Object.freeze([...unique.values()].sort((a, b) => Number(a.recipeId) - Number(b.recipeId)));
    dwarvenCatalog = { items, itemsLength: items?.length, recipeRows, rows };
    return rows;
}

// A craft recheck never loads or builds the full catalog. Startup primes it;
// an unprimed process safely uses the original per-recipe validation instead.
function preparedInputsFor(recipe) {
    const source = NativeRecipes.loadedSource();
    return source && catalog?.revision === source.revision ? catalog.inputs.get(recipe) || null : null;
}

// Native recipe objects are deliberately mutable. Check their current raw
// inputs in O(ingredients) before reusing a prepared row. Synthetic, changed,
// fractional or unsafe inputs keep the caller's original validation path.
function inputsFor(recipe) {
    const prepared = preparedInputsFor(recipe);
    const materials = recipe?.materials;
    if (!prepared || !Array.isArray(materials) || materials.length !== prepared.entries.length) return null;
    for (let index = 0; index < materials.length; index++) {
        if (materials[index] !== prepared.entries[index].input
            || materials[index]?.selfId !== prepared.entries[index].selfId
            || materials[index]?.amount !== prepared.entries[index].amount) return null;
    }
    return prepared;
}

module.exports = { rows, recipesUsing, recipesForProduct, ingredientsForRecipe, revision, recipeItemRows, currentDwarvenScrollRows, dwarvenRecipesForItems, warmup, preparedInputsFor, inputsFor };
