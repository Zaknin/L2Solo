'use strict';
// E311: a cold bot on a sale visit answers a buy ad in town. The deal goes
// through a trade meeting: the sale returns `pending` while the payer's
// worker prepares it, and the visit waits. Live, the payer's worker refuses
// (trade_meeting_need_changed: 608 in 75 min of the 2026-10-14 log); the ad stays on the board and
// every later visit pass answers it again, so the bot never leaves town.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const sellerId = 730311, buyerId = 730312;
const SKIN = 1867;
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

(async () => {
    const world = await createWorld([{ id: sellerId, classId: 0, level: 20 }, { id: buyerId, classId: 0, level: 20 }], 'e311-stuck-shopping');
    const prepare = Coordinator.requestMeetingPreparation;
    try {
        await Database.createAccount('bot_e311_fixture', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id IN (?,?)', ['bot_e311_fixture', sellerId, buyerId]]);
        await Life.init();
        const place = Town.marketTown('Giran').center;
        const spot = invoke('GameServer/Bot/Population/SpotProfiles').ensure().filter(row => row.center)
            .sort((a, b) => Math.hypot(a.center.locX - place.locX, a.center.locY - place.locY)
                - Math.hypot(b.center.locX - place.locX, b.center.locY - place.locY))[0];
        await Database.setItem(buyerId, { selfId: 57, amount: 1000000, slot: 0 });
        await Database.setItem(sellerId, { selfId: 57, amount: 1000, slot: 0 });
        await Database.setItem(sellerId, { selfId: SKIN, amount: 20, slot: 0 });
        for (const [id, name, activity, stats] of [
            [buyerId, 'E311Buyer', 'hunting', { classId: 0, generatedCold: true, money: [100, 0, 1000, 0] }],
            [sellerId, 'E311Seller', 'shopping', { classId: 0, generatedCold: true, marketSellRetryAfter: 1,
                townVisit: { town: 'Giran', startedAt: Date.now() - 60000, reason: 'sell_inventory' },
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center } }]
        ]) {
            await Life.upsertState({ characterId: id, accountName: 'bot_e311_fixture', name, level: 20,
                phase: 'cold', activity, currentRegion: 'Giran', spotId: activity === 'hunting' ? String(spot.id) : null,
                adena: id === buyerId ? 1000000 : 1000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats,
                timing: { activityStartedAt: Date.now() - 60000, lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
            }, 'e311_fixture');
        }
        // The buyer's standing need on the board: a conditional buy ad, paid
        // through a trade meeting, at a price the seller wants to answer.
        await Database.replaceBoardRecords(buyerId, 'buy_ad', [{ storeType: 3, town: 'Giran', title: 'Skins', ...place,
            lines: [{ selfId: SKIN, name: 'Animal Skin', count: 20, price: 5000, stackable: true,
                intent: { itemId: SKIN, amount: 20, price: 5000, key: `resale:${SKIN}`, recipeId: 0, valueHours: 2, valueRate: 100 } }] }], { expected: {} });
        await Afk.init();
        const ad = Afk.ownerRecords(buyerId).find(row => row.kind === 'buy_ad');
        assert(ad, 'the buy ad is on the board');

        // The payer's worker refuses the deal, as live (the ad's need changed).
        const meetings = new Set();
        Coordinator.requestMeetingPreparation = async (id, request) => {
            meetings.add(request.token);
            throw Error('trade_meeting_need_changed');
        };

        const first = await Population.resolveColdState(Life.cachedState(sellerId));
        assert(first.ok, 'the first visit pass runs');
        await settle();
        assert.equal(meetings.size, 1, 'the first pass answered the buy ad through a trade meeting');
        assert.equal(Meetings.hasPreparation(sellerId), false, 'the refused preparation is discarded');
        assert.equal(Life.cachedState(sellerId).activity, 'shopping', 'the visit waits for the pending deal');

        // The refusal is known. The next pass must not wait on the same
        // refused deal again: it finishes the visit and leaves town.
        for (let pass = 0; pass < 2 && Life.cachedState(sellerId).activity === 'shopping'; pass++) {
            await Population.resolveColdState(Life.cachedState(sellerId));
            await settle();
        }
        const after = Life.cachedState(sellerId);
        assert.notEqual(after.activity, 'shopping', `E311: the visit never ends after a refused deal: ${JSON.stringify({
            meetings: meetings.size, activity: after.activity, townVisit: after.stats.townVisit,
            marketSellRetryAfter: after.stats.marketSellRetryAfter, lastReason: after.stats.lastReason })}`);
        console.log('E311 refused trade meeting does not hold the town visit: passed');
    } finally {
        Coordinator.requestMeetingPreparation = prepare;
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
