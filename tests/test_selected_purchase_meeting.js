'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
process.env.L2NODE_PROGRESSION_RATE = 'x50';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
invoke('GameServer/DataCache').init();
const native = require('./helpers/workerEconomyDecision');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const fixture = require('./fixtures/gear_purchase_state.json');

async function run() {
    const timestamp = Date.now(), offset = timestamp - fixture.timestamp;
    const shift = value => typeof value === 'number' && value > 1700000000000 && value < 2000000000000
        ? value + offset : Array.isArray(value) ? value.map(shift)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shift(child)])) : value;
    const state = shift(fixture.state), boardRows = structuredClone(fixture.boardRows);
    const capture = await native(state, { timestamp, boardRows, nativeRoutes: true });
    const leaf = Decision.compact(capture.decision).activity;
    assert.equal(leaf.sourceType, 'afk'); assert.equal(leaf.itemId, 1458);
    assert.equal(leaf.amount, 126); assert.equal(leaf.unitPrice, 1459);
    const standing = capture.tradeIntents.find(row => row.itemId === leaf.itemId);
    assert(standing.worth < leaf.unitPrice, 'native mandatory equipment graph chooses the quote above general willingness');
    const point = invoke('GameServer/World/TownRespawn').towns.dion_town;
    const authority = require('../src/GameServer/Bot/Economy/EconomyCommit').authority(state);
    const request = { token: 'selected-crystal-purchase', actorA: state.characterId, actorB: 2004570,
        seqA: 1, seqB: 1, town: 'Dion', point: { locX: point.locX, locY: point.locY, locZ: point.locZ },
        parties: [0, 1].map(() => ({ ...authority, sequence: 1, needRevision: authority.revision,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
        lines: [{ payer: 0, itemId: 900001, selfId: 1458, count: 126, price: 1459, enchant: 0,
            adId: 8001, adRevision: 1, certificate: null }] };
    const prepared = await native(state, { timestamp, boardRows, meetingRequest: request });
    const certificate = Intent.decode(prepared.request.lines[0].certificate);
    assert.equal(certificate.itemId, 1458); assert.equal(certificate.amount, 126); assert.equal(certificate.price, 1459);
    const spendable = Funding.spendable({ ...state, stats: { ...state.stats, money: capture.statsPacket.money } }, 0,
        { r: certificate.valueRate, survivalCost: prepared.request.parties[0].survivalCost });
    assert(spendable >= 126 * 1459 + prepared.request.parties[0].route.fee,
        'actual native certificate reaches the physical wallet gate at the same funded priority');
    assert.equal(state.inventory[1458].amount, 862, 'preparation leaves physical inventory unchanged');
    const excess = structuredClone(request); excess.token = 'excess-crystal-purchase'; excess.lines[0].count = 127;
    await assert.rejects(native(state, { timestamp, boardRows, meetingRequest: excess }), /trade_meeting_need_changed/,
        'the selected finite supply does not authorize excess quantity');
    console.log('PASS actual worker selected crystal purchase, native funding and finite quantity refusal');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
