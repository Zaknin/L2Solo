'use strict';
// Producer candidate admission is bounded: every candidate gets a cheap
// pre-ranking, only the finalists reach the detailed exit pricing.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-candidate-bound-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const Sources = require('../src/GameServer/Items/ItemAcquisitionCatalog');
const ItemTemplates = require('../src/GameServer/Item/ItemTemplateIndex');
const Price = require('../src/GameServer/Bot/Economy/PriceDecision');
const Providers = require('../src/GameServer/Bot/Economy/WishProviders');
const Data = invoke('GameServer/DataCache');

// Compare against the same native facts and graph budget with only the
// detailed-pricing cap removed. Stored hashes also changed when unrelated
// equipment supply paths grew, hiding what this optimization actually checks.
function unboundedProvider() {
    const filename = require.resolve('../src/GameServer/Bot/Economy/WishProviders');
    const source = fs.readFileSync(filename, 'utf8'), cap = 'admitted.length = PRODUCER_PRICED;';
    assert.equal(source.split(cap).length, 2, 'the reference removes exactly one candidate cap');
    const reference = new Module(filename, module);
    reference.filename = filename;
    reference.paths = Module._nodeModulePaths(path.dirname(filename));
    reference._compile(source.replace(cap, ''), filename);
    return reference.exports;
}

// Real dwarven recipes with a sellable non-material, non-shot product: one
// recipe per product, so every candidate is its own production entry.
const products = new Set();
const recipes = Object.values(invoke('GameServer/Items/C4RecipeItems').loadRecipeItems())
    .filter(recipe => recipe.type === 'dwarven' && Sources.allowsRecipe(recipe) && recipe.level >= 1 && recipe.level <= 9
        && Sources.hasSource(recipe.productId) && Number(recipe.productCount) === 1
        && !/^Other\.(Shot|Material)/.test(String(ItemTemplates.find(Data.items, recipe.productId)?.template?.kind || '')))
    .sort((a, b) => a.recipeId - b.recipeId)
    .filter(recipe => !products.has(recipe.productId) && products.add(recipe.productId));
assert(recipes.length >= 40, 'enough real candidate recipes');

const persona = { primaryDrive: 'wealth', understanding: 1, traits: { commitment: 0.5, caution: 0, ambition: 0, assertiveness: 0.5 } };
// Bid prices rise with the position, so the ceiling order is the position.
function world(positions) {
    const board = new BoardIndex();
    positions.forEach(at => board.put({ id: 1000 + at, ownerId: 2000 + at, storeType: BUY, town: 'Giran', revision: 1,
        kind: 'buy_ad', custodyPolicy: 1,
        lines: [{ lineId: 1000 + at, selfId: Number(recipes[at].productId), count: 1, price: 10000 + 997 * at, enchant: 0 }] }));
    const state = { characterId: 1, level: 60, classId: 57, adena: 1e6, phase: 'cold', activity: 'hunting',
        stats: { classId: 57, dwarvenCraftLevel: 9 },
        inventory: require('./fixtures/profitable_stock_state').kitFor(57, 60).inventory, currentRegion: 'Giran',
        loc: { locX: 81100, locY: 148000, locZ: -3466 } };
    const trip = town => town === 'Giran' ? 0 : Infinity;
    trip.details = town => ({ known: town === 'Giran', hours: 0, fees: 0 });
    const ctx = { timestamp: 1e12, persona, board, hunt: { perHour: 1000, expPerHour: 0 }, deathHours: 0, hourAdena: 1000,
        price: id => products.has(Number(id)) ? 5000 : 10, buyback: id => invoke('GameServer/Items/NpcSellRules').npcBuyPrice(Number(ItemTemplates.find(Data.items, Number(id))?.template?.price || 0)), trip,
        stock: () => ({ itemId: 900, missing: 0 }), spotValue: () => ({}), gearThreatMask: 3 };
    // Half of the recipes are in the book, the rest are public candidates.
    const deps = { board, knownRecipes: positions.filter(at => at % 2).map(at => recipes[at].recipeId),
        producerRecipes: positions.filter(at => !(at % 2)).map(at => recipes[at]), spots: [] };
    return { state, ctx, deps };
}
function run(positions, providers = Providers) {
    const { state, ctx, deps } = world(positions);
    let priced = 0;
    const original = Price.bidSale;
    Price.bidSale = (...args) => { priced++; return original(...args); };
    try {
        const projection = providers.build(state, ctx, deps);
        const resale = projection.roots.filter(key => key.startsWith('resale:'))
            .map(key => projection.nodes.find(row => row.key === key));
        return { priced, resale };
    } finally { Price.bidSale = original; }
}
const range = (from, to) => Array.from({ length: to - from }, (_, at) => from + at);
try {
    const { PRODUCER_PRICED } = Providers;
    assert.equal(PRODUCER_PRICED, 12, 'detailed pricing shares the plan bound of 12 wish roots');
    const reference = unboundedProvider();
    const small = run(range(0, 5));
    const smallReference = run(range(0, 5), reference);
    assert.equal(small.priced, 5, 'with no more candidates than the bound, each is priced as before');
    assert.equal(smallReference.priced, 5);
    assert.deepEqual(small.resale.map(node => [node.key, node.valueHours, node.price, node.paths[0].recipeId]),
        [['resale:14', 8.331740736792153, 300, 4],
            ['resale:216', 18.521430897909756, 1630, 6],
            ['resale:9', 18.06448605742223, 2220, 5]]);
    assert.deepEqual(small.resale, smallReference.resale, 'full outcome matches the native unbounded reference');
    // Forty candidates: only K reach the detailed exit pricing.
    const large = run(range(0, 40));
    const largeReference = run(range(0, 40), reference);
    assert.equal(large.priced, PRODUCER_PRICED, 'only the pre-ranked finalists are priced');
    assert.equal(largeReference.priced, 40, 'the reference actually prices every admitted candidate');
    assert(large.resale.length > 0, 'the comparison includes a surviving production goal');
    assert.deepEqual(large.resale, largeReference.resale, 'full outcome matches the native unbounded reference');
    // The finalists are the K highest exit ceilings: a world of exactly those
    // candidates (unbounded) gives the same projection.
    const top = run(range(40 - PRODUCER_PRICED, 40));
    assert.equal(top.priced, PRODUCER_PRICED);
    assert.deepEqual(top.resale, large.resale, 'bounded admission keeps the highest ceilings');
    console.log(`PASS producer candidate bound: 5 -> ${small.priced} priced, 40 -> ${large.priced} priced`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
