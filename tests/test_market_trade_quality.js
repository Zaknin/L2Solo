'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const Flow = require('../src/GameServer/Bot/Economy/MarketTradeDemand');
const Listing = require('../src/GameServer/Bot/Economy/MarketListingPolicy');
const seller = 755021, buyer = 755022, itemId = 76;

(async () => {
    // Existing history gains a nullable quality column; no legacy gear row
    // may silently become evidence of an unenchanted purchase.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'market-quality-migration-'));
    try {
        const file = path.join(directory, 'history.sqlite');
        const old = new DatabaseSync(file);
        const schema = fs.readFileSync(path.resolve(__dirname, '../database/sql/history.sql'), 'utf8')
            .replace(',\n    enchant INTEGER CHECK(enchant IS NULL OR enchant >= 0)', '');
        old.exec(schema);
        old.exec(`INSERT INTO market_trades(eventKey,occurredAt,channel,sourceType,selfId,itemName,quantity,unitPrice,totalPrice)
            VALUES ('legacy',1,'player_wts','afk_player_store',76,'Sword of Delusion',1,1000,1000)`);
        old.close();
        const Store = require('../src/HistoryStore'), upgraded = Store.open(file);
        assert.equal(upgraded.prepare('SELECT enchant FROM market_trades').get().enchant, null);
        upgraded.close();
        Store.open(file).close(); // repeated startup is idempotent
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }

    const world = await createWorld([{ id: seller, name: 'QualitySeller' }, { id: buyer, name: 'QualityBuyer' }], 'market-quality');
    try {
        await Afk.init();
        await Database.setItem(buyer, { selfId: 57, amount: 1000000 });
        async function purchase(enchant) {
            const inserted = await Database.setItem(seller, { selfId: itemId, amount: 1, enchant });
            const opened = await Database.createAfkTradeShop(seller, { storeType: 1, kind: 'shop', town: 'Giran',
                locX: 83396, locY: 147904, locZ: -3400, title: 'Quality',
                lines: [{ objectId: Number(inserted.insertId), selfId: itemId, count: 1, price: 1000, enchant }] });
            const shop = opened.shop;
            const result = await Afk.buyFromShop(buyer, { afkTrade: true, storeType: 1, shopId: shop.id, ownerId: seller,
                items: [{ selfId: itemId, count: 1, price: 1000, afkTradeLineId: shop.lines[0].id }] }, itemId, 1);
            assert.equal(result.line.enchant, enchant);
        }
        for (let i = 0; i < 4; i++) await purchase(5);
        assert.equal(Flow.forecast(itemId, 'Giran'), null, '+5 purchases cannot create +0 demand');
        const listings = [{ selfId: 2275, price: 100000, count: 1 }, { selfId: itemId, price: 1000, count: 1, enchant: 0 }];
        assert.equal(Listing.prioritizeListings(listings).at(0).selfId, 2275,
            'enchanted trades cannot displace another listing with false base-item demand');
        let rows = await Database.fetchRecentBoardDeals();
        assert.deepEqual(rows.map(row => row.enchant), [5, 5, 5, 5]);
        Market.reset(); Market.load(rows);
        assert.equal(Flow.forecast(itemId, 'Giran'), null, 'restart preserves the quality distinction');
        for (let i = 0; i < 4; i++) await purchase(0);
        const before = Flow.forecast(itemId, 'Giran');
        assert(before?.applicableUnits >= 1, 'actual +0 purchases create +0 flow');
        rows = await Database.fetchRecentBoardDeals();
        Market.reset(); Market.load(rows);
        assert.equal(Flow.forecast(itemId, 'Giran').authority.revision, 4,
            'only the four plain purchases enter the forecast after replay');
        const now = Date.now();
        const legacy = [1, 2].map(n => ({ selfId: itemId, quantity: 100, unitPrice: 1000, town: 'Giran', occurredAt: now - n }));
        Market.reset(); Market.load(legacy);
        assert.equal(Flow.forecast(itemId, 'Giran', now), null, 'unknown legacy quality is not proof of +0 demand');
        Market.reset(); Market.load(legacy.map(row => ({ ...row, selfId: 1881 })));
        assert(Flow.forecast(1881, 'Giran', now), 'legacy non-enchantable resources retain their genuine flow');
        console.log('PASS native enchanted/plain purchases, listing priority, quality replay and legacy history migration');
    } finally { Afk._resetForTests(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
