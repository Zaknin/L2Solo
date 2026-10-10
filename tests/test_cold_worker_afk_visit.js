'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const nativeDecision = require('./helpers/workerEconomyDecision');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const id = 730183;

(async () => {
    const world = await createWorld([{ id, classId: 0, level: 20 }], 'native-afk-visit');
    try {
        await Life.init();
        await Database.createAccount('bot_native_afk_visit', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_native_afk_visit', id]]);
        await Database.setItem(id, { selfId: 57, amount: 1000000, slot: 0 });
        await Database.setItem(id, { selfId: 1, amount: 1, equipped: 1, slot: 7 });
        for (const selfId of [1786, 1792, 1793, 1800, 1803, 2143, 2151, 2173, 2174, 2175, 1867, 1869, 1870, 1871, 1872, 1873, 1880, 1897])
            await Database.setItem(id, { selfId, amount: 1000, slot: 0 });
        const place = Town.marketTown('Elven Village').center;
        const spot = invoke('GameServer/Bot/Population/SpotProfiles').ensure().filter(row => row.center)
            .sort((a, b) => Math.hypot(a.center.locX - place.locX, a.center.locY - place.locY)
                - Math.hypot(b.center.locX - place.locX, b.center.locY - place.locY))[0];
        const state = await Life.upsertState({ characterId: id, accountName: 'bot_native_afk_visit',
            name: 'NativeTownSeller', level: 20, exp: Number(DataCache.experience[19]),
            phase: 'cold', activity: 'shopping', currentRegion: 'Elven Village', spotId: String(spot.id),
            adena: 1000000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20,
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center } },
            timing: { activityStartedAt: Date.now(), lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
        }, 'ordinary_town_visit_fixture');
        assert.equal(Population.marketListingIntent(state, { type: 'restock' }).shouldOpen, true);
        // Real worker pricing and native lifecycle planning; no supplied sale,
        // price, demand or sell_inventory goal. Its usual purchase leaf must
        // not prevent the town's independent showcase publication.
        const native = await nativeDecision(state, { townVisit: true });
        const plan = native.plan.economyPlan;
        assert(plan, 'an ordinary shopping command carries its market publication');
        assert.equal(plan.shop, 'Elven Village', 'open in the town actually visited');
        assert(plan.sell.length >= 4, `an adventurer quotes surplus without an existing buyer: ${JSON.stringify(plan)}`);
        assert.equal(plan.take, undefined, 'town errands retain their own purchase executor');
        assert.equal(plan.buyAds, undefined);
        assert.equal(plan.travel, null);
        const prices = plan.sell.map(row => row[2]);
        assert.deepEqual(prices.slice(0, 3), prices.slice().sort((a, b) => b - a).slice(0, 3));
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), saved = Economy.forState;
        let outcome;
        try {
            Economy.forState = () => { throw Error('the town handoff must not rebuild worker pricing on main'); };
            outcome = await Population.resolveColdState(state, { precomputedPlan: native.plan,
                precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                    nextResolveAt: Date.now() + 30000, debug: {} } });
        } finally { Economy.forState = saved; }
        assert(outcome.ok);
        const shop = Afk.findOwnerProjection(id)?.shop;
        assert(shop, `the real town lifecycle executes the prepared showcase before departure: ${JSON.stringify({ plan,
            activity: outcome.state.activity, debug: outcome.debug, lastReason: outcome.state.stats.lastReason,
            records: Afk.ownerRecords(id).map(row => ({ kind: row.kind, town: row.town, items: row.lines.map(line => line.selfId) })) })}`);
        assert.equal(shop.town, 'Elven Village');
        assert.deepEqual(shop.lines.map(row => row.selfId), plan.sell.slice(0, 3).map(row => row[0]));
        const ads = Afk.ownerRecords(id).filter(row => row.kind === 'sell_ad');
        assert(ads.length > 0 && ads.length <= 5, 'overflow becomes conditional board ads');
        const own = Afk.boardIndex().ownerLines(id);
        assert.equal(new Set(own.map(line => `${line.selfId}:${line.enchant}`)).size, own.length);
        assert(!own.some(line => line.selfId === 1), 'the worn weapon cannot be offered');
        console.log('PASS native ordinary town visit: real worker prices, valuable showcase, overflow ads, reserved equipment, main handoff');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
