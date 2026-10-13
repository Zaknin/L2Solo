const assert = require('assert');
const fs = require('fs');
const path = require('path');
const isolated = require('./helpers/isolatedSocialDatabase')('merchant_partial', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);

// E253: a multi-line merchant trade whose later line fails records ONE social
// event for the lines that completed (none when no line completed).
const World = invoke('GameServer/World/World');
const Purchase = invoke('GameServer/Network/Request/Purchase');
const Sell = invoke('GameServer/Network/Request/Sell');
const TradeService = invoke('GameServer/Bot/TradeService');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');

const ServerResponse = invoke('GameServer/Network/Response');

const SHOT = 1835, SPIRIT = 2509;

// The window refresh after a whole trade needs a real character; replace the
// packet builders with plain markers.
ServerResponse.actionFailed = () => ({ kind: 'actionFailed' });
let refreshThrows = false;
for (const name of ['userInfo', 'itemsList', 'purchaseList', 'sellList', 'privateStoreListBuy']) {
    ServerResponse[name] = () => {
        if (refreshThrows) throw new Error('injected refresh failure');
        return { kind: name };
    };
}

function packet(lines) {
    const buffer = Buffer.alloc(9 + lines.length * 8);
    buffer.writeUInt8(0x1f, 0);
    buffer.writeInt32LE(lines.length, 5);
    lines.forEach(([selfId, amount], i) => {
        buffer.writeInt32LE(selfId, 9 + i * 8);
        buffer.writeInt32LE(amount, 13 + i * 8);
    });
    return buffer;
}
const merchant = () => ({ fetchId: () => 3000001, fetchName: () => 'Merchant' });
const player = () => ({ fetchId: () => 2000005, fetchName: () => 'Player', backpack: { fetchItems: () => [], fetchTotalAdena: () => 0 } });
const kinds = (sent) => sent.map((p) => p?.kind);

async function runPurchase(failAt) {
    const done = [], events = [], sent = [];
    const originals = [TradeService.buyFromStore, MarketTelemetry.recordTrade, BotSocialMemory.recordTradeCompleted];
    TradeService.buyFromStore = async (actor, store, selfId, qty) => {
        if (done.length === failAt) throw new Error('injected line failure');
        done.push(selfId);
        return { qty, name: `item${selfId}`, totalAdena: qty * 5 };
    };
    MarketTelemetry.recordTrade = () => {};
    BotSocialMemory.recordTradeCompleted = (session, merch, detail) => { events.push(detail); return Promise.resolve(null); };
    try {
        const store = { storeType: 1, items: [] };
        const session = { actor: player(), dataSendToMe: (p) => sent.push(p),
            activeMerchantTrade: { store, merchant: merchant(), prices: { [SHOT]: 5, [SPIRIT]: 5 } } };
        await Purchase(session, packet([[SHOT, 1], [SPIRIT, 1]]));
    } finally {
        [TradeService.buyFromStore, MarketTelemetry.recordTrade, BotSocialMemory.recordTradeCompleted] = originals;
    }
    return { done, events, sent };
}

async function runSell(failAt) {
    const done = [], events = [], sent = [];
    const keep = { ...TradeService };
    TradeService.sellToStore = async (actor, store, selfId, qty) => {
        if (done.length === failAt) throw new Error('injected line failure');
        done.push(selfId);
        return { qty, name: `item${selfId}`, totalAdena: qty * 5 };
    };
    TradeService.refreshStorePrices = () => {};
    TradeService.nativeStoreItems = (s) => s.items;
    TradeService.sellableCopy = (a, selfId, objectId) => ({ fetchId: () => objectId, fetchSelfId: () => selfId, fetchAmount: () => 5 });
    TradeService.storeSaleQuote = () => ({ price: 5, count: 10 });
    const record = MarketTelemetry.recordTrade, social = BotSocialMemory.recordTradeCompleted;
    MarketTelemetry.recordTrade = () => {};
    BotSocialMemory.recordTradeCompleted = (session, merch, detail) => { events.push(detail); return Promise.resolve(null); };
    try {
        const store = { storeType: 3, items: [{ selfId: SHOT, count: 10, price: 5 }, { selfId: SPIRIT, count: 10, price: 5 }] };
        const session = { actor: player(), dataSendToMe: (p) => sent.push(p), activeMerchantTrade: { store, merchant: merchant() } };
        await Sell.consumeMerchant(session, [{ objectId: 501, selfId: SHOT, amount: 1 }, { objectId: 502, selfId: SPIRIT, amount: 1 }]);
    } finally {
        Object.assign(TradeService, keep);
        MarketTelemetry.recordTrade = record; BotSocialMemory.recordTradeCompleted = social;
    }
    return { done, events, sent };
}

async function partialTrades() {
    for (const [name, run, verb] of [['purchase', runPurchase, 'bought'], ['sell', runSell, 'sold']]) {
        const ok = await run(-1);
        assert.strictEqual(ok.events.length, 1, `${name}: a whole trade is one event`);
        assert.strictEqual(ok.events[0], `${verb} 1 item${SHOT}, 1 item${SPIRIT}`, `${name}: whole detail`);

        refreshThrows = true;
        const refresh = await run(-1);
        refreshThrows = false;
        assert.strictEqual(refresh.events.length, 1, `${name}: a failing window refresh after a whole trade adds no second event`);

        const late = await run(1);
        assert.deepStrictEqual(late.done, [SHOT], `${name}: first line completed`);
        assert.deepStrictEqual(late.events, [`${verb} 1 item${SHOT}`], `${name}: one event for the completed line only`);
        assert.strictEqual(kinds(late.sent).filter((k) => k === 'actionFailed').length, 1, `${name}: window closes with actionFailed`);

        const first = await run(0);
        assert.deepStrictEqual(first.done, [], `${name}: no line completed`);
        assert.deepStrictEqual(first.events, [], `${name}: no event without a completed line`);
        assert.strictEqual(kinds(first.sent).filter((k) => k === 'actionFailed').length, 1, `${name}: failure reply`);
    }
}

async function main() {
    try {
        await partialTrades();
    } finally {
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
    console.log('Merchant partial trade social event OK');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
