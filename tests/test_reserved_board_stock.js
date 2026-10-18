'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const Meetings = require('../src/GameServer/AfkTrade/TradeMeetingService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const ids = [730231, 730232, 730233], point = { locX: 83396, locY: 147904, locZ: -3400 };
const flush = async () => { for (let n = 0; n < 24; n++) await new Promise(resolve => setImmediate(resolve)); };
(async () => {
    const world = await createWorld(ids.map(id => ({ id, level: 30 })), 'reserved-board-stock');
    const original = { prepare: Coordinator.requestMeetingPreparation, current: Coordinator.meetingPreparationCurrent,
        cancel: Coordinator.cancelMeetingPreparation };
    try {
        await Database.createAccount('bot_reserved_stock_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_reserved_stock_fixture' WHERE id IN (?,?,?)", ids]);
        await Life.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            if (id === ids[1]) await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 10, slot: 0 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30,
                adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                loc: id === ids[1] ? point : { ...point, locX: point.locX + 10000 }, currentRegion: 'Giran',
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        const source = (await Database.fetchItems(ids[1])).find(row => row.selfId === 1867);
        await Database.replaceBoardRecords(ids[1], 'sell_ad', [{ storeType: Afk.SELL, title: 'Fixture sale', town: 'Giran', ...point,
            lines: [{ objectId: source.id, selfId: 1867, name: 'Animal Skin', count: 10, price: 100, stackable: true }] }], { expected: {} });
        const ad = (await Database.fetchAfkTradeShops(ids[1]))[0];
        Afk.refreshRecord(ad);
        let preparations = 0;
        Coordinator.requestMeetingPreparation = async (id, request) => {
            preparations++;
            const side = request.actorA === id ? 0 : 1;
            return { approved: true, token: request.token, characterId: id, sequence: request.parties[side].sequence,
                route: request.parties[side].route, certificates: request.lines.map(line => line.payer === side
                    ? Intent.encode({ itemId: line.selfId, amount: line.count, price: line.price,
                        key: `resale:${line.selfId}`, recipeId: 0, valueHours: 2, valueRate: 100 }) : null) };
        };
        Coordinator.meetingPreparationCurrent = () => true;
        Coordinator.cancelMeetingPreparation = () => {};
        const publicCount = () => Afk.boardIndex().ownerLines(ids[1]).reduce((sum, line) => sum + line.count, 0);
        const observedCount = async () => MarketSnapshot.afkStores(await Database.fetchAfkTradeShops(ids[1]))
            .reduce((sum, store) => sum + store.items.filter(line => line.selfId === 1867)
                .reduce((total, line) => total + line.count, 0), 0);
        const summaryCount = () => MarketSnapshot.snapshot().topItems.find(line => line.selfId === 1867)?.wtsUnits || 0;
        const agree = async (buyer, count) => {
            const quote = await Meetings.prepareTrade(buyer, { shopId: ad.id }, 1867, count);
            return Meetings.accept(quote.preparationId, buyer);
        };
        assert.equal(publicCount(), 10);
        const first = await agree(ids[0], 4);
        assert(first.pending);
        assert.equal(publicCount(), 6, 'native acceptance publishes only the unreserved remainder');
        assert.equal(await observedCount(), 6, 'Observer lists only the unreserved remainder');
        assert.equal(summaryCount(), 6, 'the world market summary uses the same available quantity');
        const second = await agree(ids[2], 6);
        assert(second.pending);
        assert.equal(publicCount(), 0, 'two accepted buyers cannot leave their held stock on the public board');
        assert.equal(await observedCount(), 0, 'fully held stock disappears from Observer offers');
        assert.equal(summaryCount(), 0, 'fully held stock is not counted as public supply');
        const preparedBefore = preparations;
        await assert.rejects(Meetings.prepareTrade(ids[0], { shopId: ad.id }, 1867, 1), /quote_changed/);
        assert.equal(preparations, preparedBefore, 'a stale public offer is rejected before another bilateral preparation');
        await Meetings.cancel(ids[0]); await flush();
        assert.equal(publicCount(), 4, 'cancellation republishes only its own released stock');
        assert.equal(await observedCount(), 4, 'Observer reflects the independent partial release');
        assert.equal((await Database.fetchAfkTradeShop(ad.id)).lines[0].count, 10,
            'publication cannot alter the native count backing another accepted receipt');
        await Meetings.cancel(ids[2]); await flush();
        assert.equal(publicCount(), 10, 'both cancellations restore the original public quantity exactly once');
        assert.equal(await observedCount(), 10, 'Observer reflects the original restored quantity');
        const held = (await Database.fetchItems(ids[1])).filter(row => row.selfId === 1867).reduce((sum, row) => sum + row.amount, 0);
        assert.equal(held, 10);
        for (const id of ids) {
            const inventory = await Database.fetchItems(id);
            assert.equal(inventory.find(row => row.selfId === 57).amount, 120000, 'zero-fare cancellation returns the original wallet');
            if (id !== ids[1]) assert(!inventory.some(row => row.selfId === 1867), 'a cancelled buyer receives no goods');
        }
        const originalShops = Database.fetchAfkTradeShops;
        let failed = false;
        try {
            Database.fetchAfkTradeShops = async (id, ...args) => {
                if (id === ids[1] && !failed) { failed = true; throw Error('injected listing read failure'); }
                return originalShops.call(Database, id, ...args);
            };
            const committed = await agree(ids[0], 1);
            assert(committed.pending, 'listing publication failure cannot reject an already accepted agreement');
            await flush();
            assert.equal(Life.cachedState(ids[0]).activity, 'traveling',
                'an accepted buyer starts its physical route even if listing publication failed');
        } finally { Database.fetchAfkTradeShops = originalShops; }
        await Meetings.cancel(ids[0]); await flush();
        assert.equal(publicCount(), 10, 'the later native cancellation republishes the original stock');
        console.log('PASS reserved board stock: partial/full publication, stale quote refusal, independent cancellation and exact asset restoration');
    } finally {
        await flush(); Meetings.reset(); Afk._resetForTests();
        Coordinator.requestMeetingPreparation = original.prepare;
        Coordinator.meetingPreparationCurrent = original.current;
        Coordinator.cancelMeetingPreparation = original.cancel;
        await world.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
