'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
const Towns = invoke('GameServer/World/TownRespawn');
const TownNpc = invoke('GameServer/Bot/Economy/TownNpcCatalog');
const Pricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const Catalogue = require('../src/GameServer/Knowledge/GameDataCatalogue').native();
const original = { spawns: Data.npcSpawns, reader: Shops.rowsForNpc, ids: Shops.npcIds,
    town: Towns.getClosestTown, rows: TownNpc.rows, rate: process.env.L2NODE_PROGRESSION_RATE };
// Full native rows can retain distinct raw IDs which address one numeric item.
// Cold stock and market valuation intentionally fold those rows differently.
const stock = new Map([[2, [{ selfId: 1785, price: 100 }, { selfId: '01785', price: 60 },
    { selfId: 70001, price: NaN }, { selfId: 70002, price: 0 }, { selfId: 70003, price: Infinity }]],
    [1, [{ selfId: 1785, price: 100 }, { selfId: '01785', price: 70 },
        { selfId: 70001, price: 10 }, { selfId: 70002, price: -5 }]]]);
const numericLoc = { locX: 0, locY: 0, locZ: 0 }, stringLoc = { locX: '0', locY: '0', locZ: '0' };
try {
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    Data.npcSpawns = [{ spawns: [{ selfId: 2, coords: [numericLoc, numericLoc] },
        { selfId: 1, coords: [numericLoc] }, { selfId: 3, coords: [stringLoc] }] }];
    Shops.npcIds = () => [1, 2, 3];
    Shops.rowsForNpc = id => stock.get(Number(id)) || [{ selfId: 1785, price: 20 }];
    Towns.getClosestTown = () => ({ name: 'Giran', locX: 0, locY: 0 });
    TownNpc.rows = () => [{ npcSelfId: 1 }, { npcSelfId: 2 }, { npcSelfId: 3 }, { npcSelfId: 2 }];
    const view = Catalogue.npcTownOffers();
    assert.deepEqual(view.offersFor(1785), [
        { selfId: 1785, price: 100, sourceId: 1, sourceType: 'npc', town: 'Giran', repeatable: true },
        { selfId: 1785, price: 60, sourceId: 2, sourceType: 'npc', town: 'Giran', repeatable: true }
    ], 'raw ID/town keys remain distinct; ties use lower NPC ID; string coordinates are not cold stock');
    assert(Number.isNaN(view.offersFor(70001)[0].price), 'first NaN price remains the cold legacy quote');
    assert.equal(view.offersFor(70002)[0].price, -5, 'cold index keeps its existing zero/negative folding');
    assert.equal(view.offersFor(70003)[0].price, Infinity);
    assert.equal(view.itemCount, 4); assert.equal(view.quoteCount, 5);
    assert.equal(Catalogue.npcTownOffers(), view, 'warm queries borrow the same shared snapshot');
    const Cold = require('../src/GameServer/Bot/Population/ColdOccupationSources'); Cold.initialise();
    assert.equal(Cold.npcOffersFor(1785), view.offersFor(1785), 'occupation consumes this exact stock view');
    assert.equal(Pricing.npcPrice({ selfId: 1785 }), 20, 'market uses its admitted town sellers and minimum numeric item price');
    assert.equal(Pricing.npcPrice({ selfId: 70001 }), 10, 'market skips NaN and accepts the later positive price');
    assert.equal(Pricing.npcPrice({ selfId: 70002 }), Infinity, 'market admits positive prices only');
    assert.equal(Pricing.npcPrice({ selfId: 70003 }), Infinity, 'positive Infinity retains legacy market semantics');
    assert.equal(Pricing.npcPrice({ selfId: 1785, enchant: 1 }), Infinity);
    // Replacing the loaded shop reader revises the current native price view.
    Shops.rowsForNpc = () => [{ selfId: 1785, price: 200 }];
    assert.equal(Pricing.npcPrice({ selfId: 1785 }), 200);
    assert.equal(Cold.npcOffersFor(1785), view.offersFor(1785), 'cold startup-held stock does not acquire current native prices');
    // Exercise the actual town-service owner, rather than its earlier stub.
    TownNpc.rows = original.rows;
    Shops.npcIds = () => [1, 2];
    Shops.rowsForNpc = id => [{ selfId: 1785, price: Number(id) === 1 ? 100 : 20 }];
    Data.npcSpawns = [{ spawns: [{ selfId: 1, coords: [numericLoc] }] }];
    assert.equal(Catalogue.npcPriceForItem(1785), 100);
    Data.npcSpawns.push({ spawns: [{ selfId: 2, coords: [numericLoc] }] });
    assert.equal(Catalogue.npcPriceForItem(1785), 20, 'appended town sellers refresh the native seller and price views together');
    Pricing.useNpcOfferSnapshot([{ selfId: 1785, price: 500 }, { selfId: '1785', price: 400 }]);
    Shops.rowsForNpc = () => { throw Error('worker touched native stock'); };
    assert.equal(Pricing.npcPrice({ selfId: 1785 }), 400, 'worker snapshot remains its sole stock authority');
    assert.equal(Pricing.npcPrice({ selfId: 1785, npcComparable: false }), Infinity);
    console.log('PASS shared NPC stock: caller folding, raw IDs/coords, source refresh and cold/worker snapshot authority');
} finally {
    Data.npcSpawns = original.spawns; Shops.rowsForNpc = original.reader; Shops.npcIds = original.ids;
    Towns.getClosestTown = original.town; TownNpc.rows = original.rows;
    if (original.rate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = original.rate;
}
