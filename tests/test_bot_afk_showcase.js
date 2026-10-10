'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Goals = invoke('GameServer/Bot/Goals/GoalService');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const Offers = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
const owner = 730181, buyer = 730182;
const listings = [
    { selfId: 1835, count: 100000, price: 10, kind: 'Other.Shot' },
    { selfId: 1869, count: 10000, price: 100 },
    { selfId: 1786, count: 2, price: 50000 },
    { selfId: 1101, count: 1, price: 80000 },
    { selfId: 79, count: 1, price: 900000 }
];
(async () => {
    const world = await createWorld([{ id: owner, classId: 0, level: 30 }, { id: buyer, level: 30 }], 'afk-showcase');
    const saved = { evaluate: Listing.evaluate, review: Goals.review };
    try {
        await Life.init();
        await Database.createAccount('bot_showcase', 'fixture');
        await Database.createAccount('bot_showcase_buyer', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_showcase', owner]]);
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_showcase_buyer', buyer]]);
        await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 10000000, slot: 0 });
        await Database.setItem(buyer, { selfId: 57, name: 'Adena', amount: 10000000, slot: 0 });
        for (const row of listings) await Database.setItem(owner, { selfId: row.selfId, amount: row.count, slot: 0 });
        let state = await Life.upsertState({ characterId: owner, accountName: 'bot_showcase',
            name: 'ShowcaseSeller', phase: 'cold', activity: 'hunting', level: 30, adena: 10000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(owner)),
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId: 0, generatedCold: true, money: [1000, .001, 0, 0], shopTown: { town: 'Giran', at: 1 } }
        }, 'showcase_fixture');
        // Fix only the already selected sale prices. The worker plan, native
        // writers, index, projections, custody and purchase remain real.
        Listing.evaluate = () => ({ listings, decisions: [], answers: [] });
        Goals.review = async () => null;
        const prepare = () => Plan.decide(state, { ...Decision.economyFor(state), network: { activity: null } },
            { board: Afk.boardIndex(), now: Date.now(), npcOffersFor: () => [], findSpot: () => null });
        const originalBag = await Database.fetchItems(owner);
        const field = prepare();
        assert.equal(field.shop, undefined);
        await Market.executePlan(state, field);
        assert.equal(Afk.ownerRecords(owner).filter(row => row.kind === 'sell_ad').length, 5);
        assert.equal(Afk.findOwnerProjection(owner), null, 'field quoting opens no physical shop');
        assert.deepEqual(await Database.fetchItems(owner), originalBag);
        state = await Life.upsertState({ ...Life.cachedState(owner), activity: 'shopping' }, 'showcase_visit');
        const visit = prepare();
        assert.equal(visit.shop, 'Giran');
        assert.deepEqual(visit.sell.slice(0, 3).map(row => row[0]), [79, 1101, 1786],
            'unit value beats the much larger material and shot stack totals');
        assert(Buffer.byteLength(JSON.stringify(visit)) <= Plan.MAX_PLAN_PAYLOAD_BYTES);
        const adsBefore = await Database.fetchAfkTradeShops(owner);
        const ad = adsBefore.find(row => row.lines.some(line => line.selfId === 79));
        const weapon = originalBag.find(row => row.selfId === 79);
        const config = { storeType: 1, town: 'Giran', locX: 83396, locY: 147904, locZ: -3400,
            promoteAds: [{ id: ad.id, revision: ad.revision }],
            lines: [{ selfId: 79, objectId: weapon.id, count: 2, price: 900000 }] };
        await assert.rejects(Database.createAfkTradeShop(owner, config));
        assert.deepEqual(await Database.fetchAfkTradeShops(owner), adsBefore,
            'failed custody rolls the withdrawn ad back in the same transaction');
        await assert.rejects(Database.createAfkTradeShop(owner, { ...config,
            promoteAds: [{ id: ad.id, revision: ad.revision + 1 }],
            lines: [{ ...config.lines[0], count: 1 }] }), /afk_trade_shop_changed/);
        assert.deepEqual(await Database.fetchItems(owner), originalBag);
        const stale = await Life.upsertState({ ...state, activity: 'hunting',
            loc: { locX: 100000, locY: 200000, locZ: -3400 } }, 'showcase_left_town');
        await Market.executePlan(stale, visit);
        assert.equal(Afk.findOwnerProjection(owner), null, 'a stale visit cannot open a shop in the field');
        state = await Life.upsertState(state, 'showcase_returned_town');
        await Market.executePlan(state, visit);
        const shop = Afk.findOwnerProjection(owner)?.shop;
        assert(shop);
        assert.deepEqual(shop.lines.map(row => row.selfId), [79, 1101, 1786]);
        assert.deepEqual(Afk.ownerRecords(owner).filter(row => row.kind === 'sell_ad')
            .flatMap(row => row.lines.map(line => line.selfId)).sort((a, b) => a - b), [1835, 1869]);
        assert.equal(Afk.boardIndex().ownerLines(owner).filter(line => line.selfId === 79).length, 1,
            'promoted stock is indexed once, without its old conditional quote');
        state = Life.cachedState(owner);
        const unchanged = prepare();
        assert.equal(unchanged.shop, undefined);
        assert.equal(unchanged.sell.length, 0, 'an unchanged showcase schedules no repeated native publication');
        await Database.setItem(owner, { selfId: 78, amount: 1, slot: 0 });
        state = await Life.syncExternalInventory(owner, 'showcase_new_loot', state);
        state = await Life.upsertState({ ...state, activity: 'hunting', currentRegion: 'field',
            loc: { locX: 100000, locY: 200000, locZ: -3400 } }, 'showcase_remote_review');
        listings.push({ selfId: 78, count: 1, price: 950000 });
        const replacement = prepare();
        assert.equal(replacement.shop, 'Giran', 'an existing shop can receive more valuable loot from afar');
        await Market.executePlan(state, replacement);
        assert.deepEqual(Afk.findOwnerProjection(owner).shop.lines.map(row => row.selfId), [78, 79, 1101]);
        assert.equal(Afk.ownerRecords(owner).find(row => row.kind === 'sell_ad'
            && row.lines.some(line => line.selfId === 1786)).lines[0].count, 2,
            'displaced showcase stock returns to the bag and becomes an ad in the same review');
        const remainingBag = await Database.fetchItems(owner);
        assert(!remainingBag.some(row => [78, 79, 1101].includes(row.selfId)), 'showcase custody is physical');
        assert.equal(remainingBag.find(row => row.selfId === 1786).amount, 2, 'the displaced conditional ad keeps physical stock');
        const offer = Offers.bestOffer(79, { town: 'Giran', buyerCharacterId: buyer, budget: 10000000 });
        assert.equal(offer.recordKind, 'shop', 'ordinary bot browsing discovers the seated shop');
        assert.equal(offer.conditional, false);
        const buyerState = await Life.upsertState({ characterId: buyer, accountName: 'bot_showcase_buyer',
            name: 'ShowcaseBuyer', phase: 'cold', activity: 'shopping', level: 30, adena: 10000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(buyer)),
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId: 0, generatedCold: true, money: [1000000, .001, 0, 0, .01, 1000000, 79] }
        }, 'showcase_buyer');
        const bought = await ColdMarket.buyOffer(buyerState, offer);
        assert.equal(bought.purchased, true, bought.reason);
        assert.equal(bought.units, 1);
        assert.equal(bought.spent, 900000);
        assert.equal(Life.cachedState(buyer).adena, 9100000, 'the real cold bot pays the shop ask');
        assert.equal((await Database.fetchItems(buyer)).find(row => row.selfId === 79).amount, 1,
            'native AFK purchase delivers the promoted item');
        Afk._resetForTests();
        await Afk.init();
        assert(Afk.findOwnerProjection(owner), 'the remaining showcase restores after restart');
        assert.equal(Afk.offers(1101, 1).find(row => row.sourceId === owner).recordKind, 'shop');
        console.log('PASS town showcase: valuable unit asks, atomic promotion/rollback, stale visit, board browsing, purchase and restore');
    } finally { Listing.evaluate = saved.evaluate; Goals.review = saved.review; await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
