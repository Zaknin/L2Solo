const assert = require('assert');
const fs = require('fs');
const path = require('path');
const isolated = require('./helpers/isolatedSocialDatabase')('purchase_amount', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);

// E286: an NPC purchase list line with an amount below 1 is refused before
// any payment.
const World = invoke('GameServer/World/World');
const Purchase = invoke('GameServer/Network/Request/Purchase');
const Sell = invoke('GameServer/Network/Request/Sell');
const TradeService = invoke('GameServer/Bot/TradeService');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');

const ServerResponse = invoke('GameServer/Network/Response');
ServerResponse.actionFailed = () => ({ kind: 'actionFailed' });

const SHOT = 1835, SPIRIT = 2509;

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

async function npcAmounts() {
    const calls = [];
    const original = World.purchaseItems;
    World.purchaseItems = (session, list, options) => { calls.push({ list, options }); };
    try {
        const shops = {
            npc: { activeNpcShop: { itemIds: new Set([SHOT]), prices: new Map([[SHOT, 10]]) } },
            admin: { activeAdminShop: { itemIds: new Set([SHOT]) } },
            none: {}
        };
        for (const [name, shop] of Object.entries(shops)) {
            for (const amount of [0, -1, -2147483648]) {
                const sent = [];
                const session = { actor: player(), dataSendToMe: (p) => sent.push(p), ...shop };
                await Purchase(session, packet([[SHOT, 1], [SHOT, amount]]));
                assert.strictEqual(calls.length, 0, `${name}: amount ${amount} reaches no payment`);
                assert.deepStrictEqual(kinds(sent), ['actionFailed'], `${name}: amount ${amount} gets actionFailed`);
            }
            const sent = [];
            const session = { actor: player(), dataSendToMe: (p) => sent.push(p), ...shops[name] };
            await Purchase(session, packet([[SHOT, 1], [SHOT, 3]]));
            assert.strictEqual(calls.length, 1, `${name}: a valid list still pays`);
            assert.deepStrictEqual(calls[0].list.map((l) => l.amount), [1, 3]);
            calls.length = 0;
        }
    } finally { World.purchaseItems = original; }
}

async function main() {
    try {
        await npcAmounts();
    } finally {
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
    console.log('NPC purchase amount guard OK');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
