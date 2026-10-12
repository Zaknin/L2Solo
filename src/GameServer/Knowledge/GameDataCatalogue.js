'use strict';

// Public game-data queries over existing owners; returned rows are borrowed.
// Optional datasets return null when unavailable, rather than a false empty
// result. Native selected counts describe the caller's spot catalogue, never
// alive-now occupancy. Potential spawn definitions have no spot inference:
// total applies at EACH explicit coordinate, or to random placement in bounds.
// Recipe relations use the declared source as first indexed (RecipeCatalog).
// sourcesForItem requires kind 'drops'/'spoils' ('drop'/'spoil' aliases work).
// It returns borrowed origin-specific source records, not a normalized schema.
// Importing this module/factory never loads native data or exported JSON.
const EMPTY = Object.freeze([]);

function create(adapter) {
    const api = {
        origin: adapter.origin,
        capabilities: (options = {}) => adapter.capabilities(options),
        item: id => adapter.item?.(Number(id)) ?? null,
        npc: id => adapter.npc?.(Number(id)) ?? null,
        spawn: id => adapter.spawn?.(String(id)) ?? null,
        recipe: id => adapter.recipe?.(Number(id)) ?? null,
        recipesForProduct: id => adapter.recipesForProduct?.(Number(id)) ?? null,
        ingredientsForRecipe: id => adapter.ingredientsForRecipe?.(Number(id)) ?? null,
        recipesUsing: id => adapter.recipesUsing?.(Number(id)) ?? null,
        npcShopRow: (npcId, itemId) => adapter.npcShopRow?.(Number(npcId), Number(itemId)) ?? null,
        sourceIndexFor: spots => adapter.sourceIndexFor?.(spots) ?? null,
        sourcesForItem: (id, options = {}) => {
            const kind = options.kind === 'drop' ? 'drops' : options.kind === 'spoil' ? 'spoils' : options.kind;
            if (kind !== 'drops' && kind !== 'spoils') return null;
            return adapter.sourcesForItem?.(Number(id), kind === options.kind ? options : { ...options, kind }) ?? null;
        },
        selectedSourcesForItem: (id, spots) => adapter.selectedSourcesForItem?.(Number(id), spots) ?? null,
        selectedNpcSpots: (id, spots) => adapter.selectedNpcSpots?.(Number(id), spots) ?? null,
        selectedSpotNpcs: (id, spots) => adapter.selectedSpotNpcs?.(String(id), spots) ?? null,
        potentialSpawnData: () => adapter.potentialSpawnData?.() ?? null
    };
    api.relations = (kind, id, options = {}) => {
        const capabilities = api.capabilities(options);
        if (kind === 'item') return { kind, id: Number(id), origin: api.origin,
            recipes: { available: capabilities.recipes, producedBy: capabilities.recipes ? api.recipesForProduct(id) : null,
                usedBy: capabilities.recipes ? api.recipesUsing(id) : null },
            selectedSources: { available: capabilities.selectedSpots,
                ...(capabilities.selectedSpots ? { countKind: 'planner_source_weights' } : {}),
                rows: capabilities.selectedSpots ? api.selectedSourcesForItem(id, options.spots) : null } };
        if (kind === 'npc') return { kind, id: Number(id), origin: api.origin,
            selectedSpots: { available: capabilities.selectedSpots,
                rows: capabilities.selectedSpots ? api.selectedNpcSpots(id, options.spots) : null } };
        return null;
    };
    return Object.freeze(api);
}

let nativeCatalogue;
function native() {
    if (nativeCatalogue) return nativeCatalogue;
    let dataOwner, recipeOwner, sourceOwner, itemOwner, shopOwner, nativeRecipeOwner;
    const data = () => dataOwner ||= invoke('GameServer/DataCache');
    const recipes = () => recipeOwner ||= require('./RecipeCatalog');
    const sources = () => sourceOwner ||= require('./SourceCatalog');
    const items = () => itemOwner ||= require('../Item/ItemTemplateIndex');
    const shops = () => shopOwner ||= invoke('GameServer/World/Generics/NpcShopBuyLists');
    const nativeRecipes = () => nativeRecipeOwner ||= require('../Items/C4RecipeItems');
    nativeCatalogue = create({ origin: 'native',
        capabilities: ({ spots } = {}) => ({ recipes: !!nativeRecipes().loadedSource(),
            selectedSpots: Array.isArray(spots), npcShops: true, potentialSpawns: Array.isArray(data().npcSpawns) }),
        item: id => items().find(data().items, id) || null,
        npc: id => items().find(data().npcs, id) || null,
        recipe: id => nativeRecipes().resolveByRecipeId(id),
        recipesForProduct: id => recipes().recipesForProduct(id),
        ingredientsForRecipe: id => recipes().ingredientsForRecipe(id),
        recipesUsing: id => recipes().recipesUsing(id),
        npcShopRow: (npcId, itemId) => shops().rowForNpc(npcId, itemId),
        sourceIndexFor: spots => sources().sourcesByItem(spots),
        sourcesForItem: (id, { spots, kind } = {}) => {
            const rows = sources().sourcesByItem(spots).get(id) || EMPTY;
            return kind ? rows.filter(row => row.kind === (kind === 'drops' ? 'drop' : kind === 'spoils' ? 'spoil' : kind)) : rows;
        },
        selectedSourcesForItem: (id, spots) => sources().sourcesByItem(spots).get(id) || EMPTY,
        selectedNpcSpots: (id, spots) => sources().selectedNpcSpots(id, spots),
        selectedSpotNpcs: (id, spots) => sources().selectedSpotNpcs(id, spots),
        potentialSpawnData: () => sources().potentialSpawnData()
    });
    return nativeCatalogue;
}

module.exports = { create, native };
