const assert = require('assert');
const fs = require('fs');
const path = require('path');
const isolated = require('./helpers/isolatedSocialDatabase')('merchant_window_items', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);

// U42: the native merchant buy window is built from the store in two places,
// opening the window (Select) and re-rendering it after a purchase (Purchase).
// Pin the rows each one sends and where each refreshes prices, so the shared
// builder keeps both exactly.
const Purchase = invoke('GameServer/Network/Request/Purchase');
const Select = invoke('GameServer/Actor/Generics/Select');
const TradeService = invoke('GameServer/Bot/TradeService');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const AfkTradeService = invoke('GameServer/AfkTrade/AfkTradeService');
const ServerResponse = invoke('GameServer/Network/Response');

const SHOT = 1835, SPIRIT = 1463, WIDE = 1464, UNKNOWN = 999999;
const MERCHANT_ID = 3000077;
let sent = [];
const lists = [];
for (const name of ['userInfo', 'itemsList', 'privateStoreMsg', 'privateStoreBuyMsg', 'destSelected', 'relationChanged']) {
    ServerResponse[name] = () => ({ kind: name });
}
ServerResponse.actionFailed = () => ({ kind: 'actionFailed' });
ServerResponse.purchaseList = (items, adena) => {
    lists.push({ adena, rows: items.map((item) => ({ id: item.fetchId(), selfId: item.fetchSelfId(), amount: item.fetchAmount(),
        price: item.fetchPrice(), name: item.fetchName() })) });
    return { kind: 'purchaseList' };
};

const steps = [];
const realNative = TradeService.nativeStoreItems;
const realRefresh = TradeService.refreshStorePrices;
TradeService.nativeStoreItems = (store) => { steps.push('native'); return realNative(store); };
// Each refresh raises the shot price by one, so a row shows which refresh it saw.
TradeService.refreshStorePrices = (store, actor) => {
    steps.push(`refresh:${actor?.fetchId?.() ?? 'none'}`);
    store.items[0].price += 1;
    return store;
};
TradeService.buyFromStore = async (actor, store, selfId, qty) => {
    store.items.find((item) => item.selfId === selfId).count -= qty;
    return { qty, name: `item${selfId}`, totalAdena: qty * 5 };
};
MarketTelemetry.recordTrade = () => {};
BotSocialMemory.recordTradeCompleted = () => Promise.resolve(null);

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

async function main() {
    invoke('GameServer/DataCache').init();
    const store = { storeType: 1, revision: 1, items: [
        { selfId: SHOT, objectId: 91001, count: 100, price: 7 },
        { selfId: SPIRIT, objectId: 91002, count: 50, price: 11 },
        { selfId: WIDE, objectId: 91003, count: 5, price: 5000000000 },
        { selfId: UNKNOWN, objectId: 91004, count: 9, price: 13 }
    ] };
    const merchant = { fetchId: () => MERCHANT_ID, fetchName: () => 'PinMerchant', fetchPrivateStore: () => store,
        fetchPrivateStoreType: () => 1, fetchTitle: () => '' };
    let dest = MERCHANT_ID;
    const actor = { fetchId: () => 2000077, fetchName: () => 'PinPlayer', fetchDestId: () => dest, setDestId: (id) => { dest = id; },
        backpack: { fetchItems: () => [], fetchTotalAdena: () => 4321 } };
    const session = { accountId: 'pin_player', actor, dataSendToMe: (p) => sent.push(p) };
    const findProjection = AfkTradeService.findProjection;
    AfkTradeService.findProjection = (id) => Number(id) === MERCHANT_ID ? { actor: merchant } : null;
    try {
        Select(session, actor, { id: MERCHANT_ID });
    } finally {
        AfkTradeService.findProjection = findProjection;
    }
    assert.deepStrictEqual(steps, ['refresh:2000077', 'native', 'native'], 'open: refresh, then quotes, then rows');
    assert.deepStrictEqual(session.activeMerchantTrade.prices, { [SHOT]: 8, [SPIRIT]: 11, [UNKNOWN]: 13 });
    assert.strictEqual(lists.length, 1);
    assert.strictEqual(lists[0].adena, 4321);
    assert.deepStrictEqual(lists[0].rows.map(({ name, ...row }) => row), [
        { id: 91001, selfId: SHOT, amount: 100, price: 8 },
        { id: 91002, selfId: SPIRIT, amount: 50, price: 11 }
    ], 'open: rows carry the store object id, count and refreshed price; an unrepresentable price or an unknown item is omitted');
    assert(lists[0].rows.every((row) => typeof row.name === 'string' && row.name.length > 0), 'rows carry the item template');

    steps.length = 0;
    sent = [];
    await Purchase(session, packet([[SHOT, 2]]));
    assert.deepStrictEqual(steps, ['refresh:2000077', 'native', 'native'], 'after a purchase: refresh, then rows, then quotes');
    assert.strictEqual(lists.length, 2);
    assert.deepStrictEqual(lists[1].rows.map(({ name, ...row }) => row), [
        { id: 91001, selfId: SHOT, amount: 98, price: 9 },
        { id: 91002, selfId: SPIRIT, amount: 50, price: 11 }
    ], 'after a purchase: rows show the new count and the refreshed price');
    assert.deepStrictEqual(lists[1].rows.map((row) => row.name), lists[0].rows.map((row) => row.name));
    assert.deepStrictEqual(session.activeMerchantTrade.prices, { [SHOT]: 9, [SPIRIT]: 11, [UNKNOWN]: 13 });
    assert.deepStrictEqual(sent.map((p) => p.kind), ['userInfo', 'itemsList', 'purchaseList']);
    console.log('Merchant purchase window item checks passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
        TradeService.nativeStoreItems = realNative;
        TradeService.refreshStorePrices = realRefresh;
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    });
