const data = require('../../../data/Items/weapon_sa_exchanges.json');
const byId = new Map(data.recipes.map(recipe => [recipe.id, recipe]));
const blacksmiths = new Set(data.blacksmiths);
const crystalIds = new Set(Object.keys(require('../../../data/Items/soul_crystals.json').crystals).map(Number));
const optionIndex = require('../Knowledge/NativeServiceIndex').currentIndex(['station', 'sourceId', 'operation'], recipes => {
    const stations = new Map();
    for (const recipe of recipes) {
        if (!stations.has(recipe.station)) stations.set(recipe.station, new Map());
        const sources = stations.get(recipe.station);
        if (!sources.has(recipe.sourceId)) sources.set(recipe.sourceId, new Map());
        const operations = sources.get(recipe.sourceId);
        if (!operations.has(recipe.operation)) operations.set(recipe.operation, []);
        operations.get(recipe.operation).push(recipe);
    }
    return stations;
});
function station(npcId) {
    if (Number(npcId) === 8126) return 'mammon';
    if (Number(npcId) === 8092) return 'blackMarket';
    return blacksmiths.has(Number(npcId)) ? 'blacksmith' : null;
}
function resolve(npcId, recipeId) {
    const recipe = byId.get(recipeId);
    return recipe?.station === station(npcId) ? recipe : null;
}
function options(npcId, sourceId, operation) {
    if (Array.isArray(data.recipes) && !data.recipes.length) return [];
    // Object conversions can have side effects; retain the original per-row
    // short circuit in that contract instead of converting those inputs early.
    if (npcId && ['object', 'function'].includes(typeof npcId)
        || sourceId && ['object', 'function'].includes(typeof sourceId) || typeof sourceId === 'symbol') {
        return data.recipes.filter(r => r.station === station(npcId) && r.sourceId === Number(sourceId) && r.operation === operation);
    }
    const index = optionIndex(data.recipes);
    if (!index) return data.recipes.filter(r => r.station === station(npcId) && r.sourceId === Number(sourceId) && r.operation === operation);
    const sources = index.get(station(npcId));
    if (!sources) return [];
    const id = Number(sourceId);
    return Number.isNaN(id) || Number.isNaN(operation) ? [] : (sources.get(id)?.get(operation) || []).slice();
}
// Lisvus tax-only Adena ingredients are a tax base, not a service fee. The
// current world has no castle tax service, so its effective rate is zero.
function costs(recipe) {
    // Ordinary C/B smiths charge the sourced C4 gemstones as well as the
    // exact crystal. Mammon's A/S catalogue remains its separate service.
    return recipe.operation === 'install'
        ? recipe.costs.filter(cost => crystalIds.has(cost.selfId)
            || recipe.station === 'blacksmith' && [2131, 2132].includes(cost.selfId))
        : recipe.costs;
}
function links(npcId) {
    const kind = station(npcId);
    if (!kind) return '';
    return '<br>' + (kind !== 'blackMarket' ? '<a action="bypass -h weapon-sa menu install">Install a weapon special ability</a><br>' : '')
        + (kind !== 'blacksmith' ? '<a action="bypass -h weapon-sa menu remove">Remove a weapon special ability</a><br>' : '');
}
module.exports = { station, resolve, options, costs, links, recipes: data.recipes };
