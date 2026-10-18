'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('crystal-surplus-market');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Supplies = invoke('GameServer/Clan/ClanSupplyPolicy');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const Native = require('./helpers/nativeMarketFixture');
const sellerId = 938002, buyerId = 938001;
const point = { locX: 83396, locY: 147904, locZ: -3400 };
const saleOptions = { unlimited: true, keptAmounts: {} };
const inventory = (id, amount = 20) => ({ [id]: { selfId: id, amount, kind: 'Other.None', stackable: true } });
const state = (id = 1458, stats = {}) => ({ characterId: sellerId, accountName: 'bot_crystal_seller',
    phase: 'cold', activity: 'shopping', currentRegion: 'Giran', level: 40,
    inventory: inventory(id), stats: { classId: 0, ...stats }, timing: {}, loc: point });
const exchange = { strategy: 'luxury_exchange', status: 'active', target: { selfId: 95 },
    materials: [{ selfId: 1458, amount: 12 }] };
const count = (s, extra = {}) => Disposition.saleCandidates(s, { ...saleOptions, ...extra })
    .find(row => row.selfId === 1458)?.count || 0;
const adopt = result => Object.values(result.coldLifeRows || {}).forEach(row => Life.acceptLifecycleRow(row));

async function run() {
    Data.init(); Database.init();
    for (const id of [1458, 1459, 1460, 1461, 1462]) {
        const bot = state(id), before = structuredClone(bot);
        const candidate = Disposition.saleCandidates(bot, saleOptions).find(row => row.selfId === id);
        assert.equal(candidate?.count, 20, `free grade crystal ${id} reaches sale selection`);
        assert.equal(Listing.classify(bot, candidate).action, 'market');
        assert.equal(Disposition.isSpareConsumable(bot.inventory[id]), false, 'crystals remain crafting inputs');
        assert.deepEqual(bot, before, 'sale selection does not consume physical stock');
    }
    assert.equal(count(state(1458, { equipmentPlan: exchange })), 8, 'C luxury inputs stay reserved');
    assert.equal(count(state(1458, { equipmentPlan: { ...exchange, materials: [{ selfId: 1458, amount: 25 }] } })),
        0, 'an incomplete exchange cannot sell its collected crystals');
    assert.equal(count(state(1458, { equipmentPlan: { strategy: 'craft', status: 'active',
        materials: [{ selfId: 1458, amount: 6 }] } })), 14, 'equipment craft inputs stay reserved');
    const paused = { ...exchange, status: 'deferred', strategy: 'none', reason: 'wish_focus',
        target: { selfId: 76, slot: 7 }, exchange: { kind: 'luxury_exchange' } };
    assert.equal(count(state(1458, { equipmentPlan: paused, wishFocus: ['stock:scrolls', 0, 100] })), 8,
        'a temporary scroll restock preserves the unfinished personal exchange reserve');
    assert.equal(count(state(1458, { equipmentPlan: { ...paused, materials: [{ selfId: 1458, amount: 25 }] } })), 0,
        'all collected crystals remain reserved while a deferred exchange is incomplete');
    assert.equal(count(state(1458, { equipmentPlan: { ...paused, reason: 'cancelled' } })), 20,
        'a cancelled plan releases its inputs');
    assert.equal(count(state(1458, { equipmentPlan: { ...paused, target: { selfId: 80, slot: 7 } } })), 20,
        'a deferred higher-grade target blocked by the C milestone releases its old reservation');
    const resumedCraft = { strategy: 'none', status: 'deferred', reason: 'wish_focus', recipeId: 1,
        target: { selfId: 76, slot: 7 }, materials: [{ selfId: 1458, amount: 6 }] };
    assert.equal(count(state(1458, { equipmentPlan: resumedCraft })), 14, 'deferred personal craft retains its collected inputs');
    const bridge = Selection.withBridgeInputPreparation(state(), paused,
        { strategy: 'npc', status: 'active', weaponBridge: true, target: { selfId: 129, slot: 7 } });
    assert(bridge.inputPreparation, 'a D weapon bridge keeps the unfinished C input goal');
    assert.equal(Selection.withBridgeInputPreparation(state(), { ...paused, reason: 'cancelled' },
        { ...bridge, inputPreparation: undefined }).inputPreparation, undefined,
        'a bridge does not revive a cancelled C goal');
    const bridgeState = state(1458, { equipmentPlan: bridge });
    assert.equal(count(bridgeState), 8, 'the executable D goal cannot sell C inputs');
    const bridgeIterator = invoke('GameServer/Bot/Population/ColdOccupationSources').reservations(bridgeState);
    let bridgeStep; do { bridgeStep = bridgeIterator.next(); } while (!bridgeStep.done);
    assert.equal(bridgeStep.value[1458], 12, 'worker reservations keep C inputs across the bridge');
    assert.equal(count(state(1458, { equipmentPlan: { ...bridge, reason: 'cancelled' } })), 20);
    assert.equal(count(state(1458, { classId: 37, equipmentPlan: bridge })), 20,
        'a class change releases an incompatible retained target');
    const fulfilledBridge = state(1458, { equipmentPlan: bridge });
    fulfilledBridge.inventory[76] = { selfId: 76, amount: 1, equipped: true, equippedSlots: [7], slot: 7 };
    assert.equal(count(fulfilledBridge), 20, 'a fulfilled C target releases retained inputs');
    assert.notEqual(Disposition.reservationInputKey(bridgeState),
        Disposition.reservationInputKey(state(1458, { equipmentPlan: { ...bridge, inputPreparation: undefined } })),
        'reservation caches distinguish the retained C goal');
    const sourceIterator = invoke('GameServer/Bot/Population/ColdOccupationSources').reservations(
        state(1458, { equipmentPlan: paused }));
    let sourceStep; do { sourceStep = sourceIterator.next(); } while (!sourceStep.done);
    assert.equal(sourceStep.value[1458], 12, 'worker stock feasibility uses the same deferred exchange reserve');
    assert.equal(Disposition.reservationInputKey(state(1458, { equipmentPlan: paused })),
        Disposition.reservationInputKey(state(1458, { equipmentPlan: { ...paused, strategy: 'luxury_exchange', status: 'active' } })),
        'temporary activity changes do not invalidate the physical input reservation');
    assert.equal(count(state(), { reserved: { 1458: 7 } }), 13, 'selected production inputs stay reserved');
    const stock = state(); stock.inventory[1458].reservedAmount = 9;
    assert.equal(count(stock), 11, 'explicit physical reservations stay owned');
    stock.inventory[1458].acceptedCustomer = true;
    assert.equal(count(stock), 0, 'accepted customer stock cannot be sold');
    const selected = { kind: 'luxury_exchange', grossRequirements: [{ key: 'item:1458', amount: 12 }],
        requirements: [{ key: 'item:1458', amount: 12 }] };
    const network = { activity: { rootKey: 'power:95:14' },
        queue: [{ key: 'power:95:14', plan: { requirements: [{ key: 'item:95', plan: selected }] } }] };
    const selectedReserve = Disposition.selectedCraftAmounts(state(), network);
    assert.equal(selectedReserve[1458], 12, 'selected wish DAG protects the physical luxury input');
    assert.equal(count(state(), { reserved: selectedReserve }), 8);
    Supplies.useRowSource(id => id === 42 ? [42, 1, [[1458, 3]], 1] : undefined);
    assert.equal(count(state(1458, { clanId: 42, equipmentPlan: exchange })), 5,
        'personal C exchange and active clan need have separate quantities');
    Supplies.useRowSource();

    for (const [id, name] of [[sellerId, 'CrystalSeller'], [buyerId, 'CrystalBuyer']]) {
        await Native.character(Database, id, name, `bot_crystal_${id}`, point);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000, stackable: true });
    }
    await Database.setItem(sellerId, { selfId: 1458, name: 'Crystal: D-Grade', amount: 20, stackable: true });
    for (const id of [sellerId, buyerId]) await Life.upsertState({ ...state(), characterId: id,
        accountName: `bot_crystal_${id}`, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId: 0, money: [1000, 0, 0, 0], ...(id === sellerId ? { equipmentPlan: bridge } : {}) },
        vitals: { hp: 100, maxHp: 100 } }, 'fixture');
    async function accept(amount, token) {
        const old = (await Database.fetchAfkTradeShops(buyerId)).filter(row => row.kind === 'buy_ad');
        await Database.replaceBoardRecords(buyerId, 'buy_ad', [{ storeType: 3, town: 'Giran',
            lines: [{ selfId: 1458, name: 'Crystal: D-Grade', count: amount, price: 10, stackable: true,
                intent: { itemId: 1458, amount, price: 10, key: 'resale:1458', recipeId: 0,
                    valueHours: 2, valueRate: 100 } }] }],
        { expected: Object.fromEntries(old.map(row => [row.id, row.revision])) });
        const ad = (await Database.fetchAfkTradeShops(buyerId)).find(row => row.kind === 'buy_ad');
        const parties = await Promise.all([buyerId, sellerId].map(id => Database.prepareTradeParticipant(id)));
        const source = parties[1].inventory.find(row => row.selfId === 1458);
        return Database.acceptTradeMeeting({ token, actorA: buyerId, actorB: sellerId,
            seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Giran', point,
            lines: [{ payer: 0, itemId: source.id, selfId: 1458, enchant: 0, count: amount, price: 10,
                needAdId: ad.id, needAdRevision: ad.revision, certificate: JSON.parse(ad.lines[0].intentJson) }],
            parties: parties.map(p => ({ ...p, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })) });
    }
    await assert.rejects(accept(9, 'crystal-reserve-overdraw'), /economy_material_protected/,
        'atomic acceptance cannot reserve crystals needed by C exchange');
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 1458), 20, 'refused sale preserves stock');
    const accepted = await accept(8, 'crystal-surplus-sale'); adopt(accepted);
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 1458), 12, 'only surplus enters meeting custody');
    const completed = await Database.arriveTradeMeeting(accepted.meeting.id); adopt(completed);
    assert.equal(completed.meeting.state, 'completed');
    for (const id of [sellerId, buyerId]) await Database.settleBoardOwner(id);
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 1458), 12, 'C reserve survives final delivery');
    assert.equal(Native.amount(await Database.fetchItems(buyerId), 1458), 8, 'buyer receives the physical surplus');
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 57), 10080);
    assert.equal(Native.amount(await Database.fetchItems(buyerId), 57), 9920);
    console.log('Crystal surplus: grade admission, C exchange, craft, clan, customer reserves and native settlement passed');
}
run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
