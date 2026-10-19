const assert = require('assert'); require('../src/Global');
// A standing buy ad whose price ceiling fell is not repriced while its owner has a
// staged meeting preparation: the repricing rewrites the board row, which discards
// the preparation the meeting was quoted on. Once the preparation is gone, the
// review reprices the line as usual.
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Alternative = require('../src/GameServer/Bot/Economy/BidPurchaseAlternative');
const ownerId = 1, otherId = 2, CEILING = 600;
const state = { characterId: ownerId, phase: 'cold', activity: 'hunting', adena: 1000000, stats: { money: [10000, 0, 0, 0] },
    simulation: { revision: 0 }, timing: {} };
const ad = { id: 77, kind: 'buy_ad', town: 'Giran', revision: 3,
    lines: [{ id: 5, selfId: 1458, count: 2, price: 1000, pricing: { price: 1000 } }] };
const party = { phase: 'cold', revision: 0, hotAt: 0, sequence: 1, needRevision: 0,
    route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } };
const original = { cached: Life.cachedState, snapshot: Life.snapshot, records: AfkTrade.ownerRecords, reprice: AfkTrade.repriceBotLines,
    index: AfkTrade.boardIndex, forLine: Alternative.forLine, cashCap: Alternative.cashCap };
(async () => {
    try {
        const repriced = [];
        Life.cachedState = () => state; Life.snapshot = () => state;
        AfkTrade.ownerRecords = () => [ad]; AfkTrade.boardIndex = () => ({});
        AfkTrade.repriceBotLines = async (id, reprices) => { repriced.push(...reprices); return {}; };
        Alternative.forLine = () => CEILING; Alternative.cashCap = () => 100000;
        Meetings.stage({ token: 'bid-review-preparation', actorA: ownerId, actorB: otherId, seqA: 1, seqB: 1,
            town: 'Giran', point: { locX: 0, locY: 0, locZ: 0 }, parties: [party, { ...party }],
            lines: [{ payer: 0, itemId: 3, selfId: 1458, count: 1, price: 10 }] });
        assert(Meetings.hasPreparation(ownerId));

        const held = await Market.reviewPurchaseLimits(state);
        assert.strictEqual(held.changed, false, 'the review waits while a preparation is staged');
        assert.strictEqual(repriced.length, 0, 'no line is rewritten under the staged meeting');
        assert(Meetings.hasPreparation(ownerId), 'the preparation survives the review');
        assert.strictEqual(ad.lines[0].price, 1000, 'the ad keeps its price');

        Meetings.discard('bid-review-preparation');
        assert(!Meetings.hasPreparation(ownerId));
        const reviewed = await Market.reviewPurchaseLimits(state);
        assert.strictEqual(reviewed.changed, true, 'without a preparation the overpriced line is reviewed');
        assert.strictEqual(repriced.length, 1);
        assert.strictEqual(repriced[0].price, CEILING, 'the line is repriced to the fallen ceiling');
        console.log('PASS standing bid review waits while a meeting preparation is staged');
    } finally {
        Meetings.reset();
        Life.cachedState = original.cached; Life.snapshot = original.snapshot;
        AfkTrade.ownerRecords = original.records; AfkTrade.repriceBotLines = original.reprice; AfkTrade.boardIndex = original.index;
        Alternative.forLine = original.forLine; Alternative.cashCap = original.cashCap;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
