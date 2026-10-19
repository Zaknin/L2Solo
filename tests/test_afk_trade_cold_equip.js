const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-afk-trade-cold-equip.sqlite');
const BONE_HELMET = 45; // slot 6, wearable at level 40
const LONG_SWORD = 2; // slot 7

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

function character(name) {
    return { name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 83000, locY: 148000, locZ: -3400 };
}

async function makeCharacter(account, name, items) {
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, character(name))).insertId);
    const ids = {};
    for (const entry of items) {
        ids[entry.selfId] = Number((await Database.setItem(id, { enchant: 0, equipped: false, slot: 0, ...entry })).insertId);
    }
    return { id, ids };
}

// A far (cold) bot buys a wearable item from a bot's sell shop. The buyer's
// DB fill transaction equips it (EconomyCommit.admit -> completeEconomyStepUnsafe
// -> equipColdPurchaseUnsafe) and the fenced row of the result is the buyer's
// new state: nothing re-equips it on main after the trade.
async function farBuyerWears({ label, selfId, name, slot }) {
    const seller = await makeCharacter(`bot_${label}_seller`, `${label}Seller`, [{ selfId, name, amount: 1 }]);
    const buyer = await makeCharacter(`bot_${label}_buyer`, `${label}Buyer`, [{ selfId: 57, name: 'Adena', amount: 100000 }]);
    await LifeState.upsertState({
        characterId: buyer.id, accountName: `bot_${label}_buyer`, name: `${label}Buyer`, level: 40, exp: 1000, sp: 100,
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(buyer.id)),
        adena: 100000, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, classId: 0, money: [36000, 0, 0, 0] }, timing: {}
    }, 'test_cold_equip_seed');
    await AfkTrade.publishBot(seller.id, {
        storeType: AfkTrade.SELL, title: name, town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: character(`${label}Seller`) },
        lines: [{ objectId: seller.ids[selfId], selfId, name, count: 1, price: 1000, stackable: false }]
    });

    const store = AfkTrade.findOwnerProjection(seller.id).actor.fetchPrivateStore();
    const trade = await AfkTrade.buyFromShop(buyer.id, store, selfId, 1, { coldState: LifeState.cachedState(buyer.id) });

    const fenced = trade.coldLifeRows?.[buyer.id];
    assert(fenced, `${label}: the fill result carries the buyer's fenced row`);
    const summary = JSON.parse(fenced.inventorySummary);
    const entry = summary[selfId];
    assert(entry, `${label}: the fenced row holds the bought item`);
    assert.strictEqual(entry.equipped, true, `${label}: the fenced row has the item equipped`);
    assert(entry.equippedSlots?.includes(slot), `${label}: the fenced row names slot ${slot}: ${JSON.stringify(entry.equippedSlots)}`);
    const stats = JSON.parse(fenced.statsJson);
    assert(stats.equipment?.some((piece) => Number(piece.selfId) === selfId && Number(piece.slot) === slot),
        `${label}: stats.equipment of the fenced row lists the item`);

    const [row] = (await Database.fetchItems(buyer.id)).filter((item) => Number(item.selfId) === selfId);
    assert(row, `${label}: the item is in the buyer's bag`);
    assert.strictEqual(Number(row.equipped), 1, `${label}: the DB row is equipped`);
    assert.strictEqual(Number(row.slot), slot, `${label}: the DB row keeps its slot`);

    // The cold state main holds after the trade is the fenced row, no re-equip.
    assert.strictEqual(trade.coldState.inventory[selfId].equipped, true, `${label}: the accepted cold state wears it`);
    assert.strictEqual(LifeState.cachedState(buyer.id).inventory[selfId].equipped, true, `${label}: the cache wears it`);
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();

    await farBuyerWears({ label: 'helmet', selfId: BONE_HELMET, name: 'Bone Helmet', slot: 6 });
    await farBuyerWears({ label: 'sword', selfId: LONG_SWORD, name: 'Long Sword', slot: 7 });

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('A far buyer of a wearable AFK lot wears it: fenced row, stats.equipment and DB row agree');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
