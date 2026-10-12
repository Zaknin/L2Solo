'use strict';

// Wrap the reference service's already-owned Maps and relation lists. No
// native require/init or extra payload copy: optional native queries are
// supplied explicitly by a caller that already owns the loaded native data.
const { create } = require('./GameDataCatalogue');
const EMPTY = Object.freeze([]);

function createExportedCatalogue(data, { nativeCatalogue = null } = {}) {
    const hasRecipes = () => !!nativeCatalogue?.capabilities().recipes;
    return create({ origin: 'exported',
        capabilities: (options = {}) => {
            const native = nativeCatalogue?.capabilities(options);
            return { recipes: !!native?.recipes, selectedSpots: !!native?.selectedSpots,
                npcShops: !!native?.npcShops, potentialSpawns: true };
        },
        item: id => data.itemById.get(id) || null,
        npc: id => data.mobById.get(id) || null,
        spawn: id => data.spawnById.get(id) || null,
        sourcesForItem: (id, { kind } = {}) => {
            const sources = data.itemById.get(id)?.sources;
            return sources?.[kind] || EMPTY;
        },
        recipe: id => hasRecipes() ? nativeCatalogue.recipe(id) : null,
        recipesForProduct: id => hasRecipes() ? nativeCatalogue.recipesForProduct(id) : null,
        ingredientsForRecipe: id => hasRecipes() ? nativeCatalogue.ingredientsForRecipe(id) : null,
        recipesUsing: id => hasRecipes() ? nativeCatalogue.recipesUsing(id) : null,
        npcShopRow: (npcId, itemId) => nativeCatalogue?.npcShopRow(npcId, itemId) ?? null,
        selectedSourcesForItem: (id, spots) => nativeCatalogue?.selectedSourcesForItem(id, spots) ?? null,
        selectedNpcSpots: (id, spots) => nativeCatalogue?.selectedNpcSpots(id, spots) ?? null,
        selectedSpotNpcs: (id, spots) => nativeCatalogue?.selectedSpotNpcs(id, spots) ?? null,
        potentialSpawnData: () => ({ kind: 'potential_definitions', origin: 'exported',
            revision: data.manifest?.generatedAt || null, definitions: data.spawns,
            totalSemantics: 'per_explicit_coordinate_or_random_total_in_bounds',
            periodSemantics: 'day_or_night_otherwise_always', population: 'definition_only' })
    });
}

module.exports = { createExportedCatalogue };
