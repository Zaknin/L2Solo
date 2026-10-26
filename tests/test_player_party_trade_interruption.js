'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const ids = [730341, 730342], point = { locX: 83396, locY: 147904, locZ: -3400 };
(async () => {
    const fixture = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'player-party-trade-interruption');
    try {
        await Life.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 20, slot: 0 });
            await Life.upsertState({ characterId: id, name: `Trader${id}`, level: 30,
                phase: 'cold', activity: 'shopping', adena: 120000, loc: point,
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        const parties = await Promise.all(ids.map(id => Database.prepareTradeParticipant(id)));
        const request = { token: 'player-party-refund', actorA: ids[0], actorB: ids[1],
            seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Giran', point,
            lines: [{ payer: 0, itemId: parties[1].inventory.find(row => row.selfId === 1867).id,
                selfId: 1867, count: 6, price: 100, certificate: Intent.encode({ itemId: 1867,
                    amount: 6, price: 100, key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 }) }],
            parties: parties.map(p => ({ ...p, route: { fee: 0, scroll: false, method: 'walk', durationMs: 1000 } })) };
        const accepted = await Database.acceptTradeMeeting(request, { freshPreparation: true, validatePreparation: () => true });
        Object.values(accepted.coldLifeRows).forEach(row => Life.acceptLifecycleRow(row));
        assert.equal(Meetings.canJoinParty(ids[0]), false, 'autonomous parties still respect native trade custody');
        assert.equal(await fixture.amount(ids[0], 57), 119400);
        assert.equal(await fixture.amount(ids[1], 1867), 14);
        assert.equal(await Meetings.prepareForPlayerParty(ids[0]), true);
        for (const id of ids) {
            assert.equal(await fixture.amount(id, 57), 120000, 'cancelled custody refunds Adena exactly once');
            assert.equal(await fixture.amount(id, 1867), 20, 'cancelled custody returns goods to the original owner');
            assert.equal(Life.cachedState(id).stats.tradeMeeting, undefined);
            assert.equal(Meetings.canJoinParty(id), true);
            const receipt = await Database.fetchTradeMeetingReceipt(request.token, id);
            assert.equal(receipt.outcome, 'cancelled');
        }
        assert.equal(await Database.fetchTradeMeeting(accepted.meeting.id), undefined, 'both sides acknowledge the native receipt');
        Meetings.stage({ ...request, token: 'unaccepted-party-interruption' });
        assert.equal(Meetings.hasPreparation(ids[0]), true);
        assert.equal(await Meetings.prepareForPlayerParty(ids[0]), true);
        assert.equal(Meetings.hasPreparation(ids[0]), false);
        assert.equal(Meetings.hasPreparation(ids[1]), false, 'an unaccepted bilateral preparation is retired on both sides');
        assert.equal(Meetings.counters().preparations, 0);
        console.log('Player party trade interruption: native refunds, receipts and unaccepted preparation cleanup passed');
    } finally { Meetings.reset(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
