'use strict';
// E317: party formation hydrates fresh row copies; an unchanged cold row reuses
// its solo route choice for REVIEW_MS, any change of content, spots or time recomputes.
const assert = require('node:assert/strict');
require('../src/Global');
const Income = invoke('GameServer/Bot/Population/PartyIncomeComparison');
const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');

const original = Route.select;
let selects = 0;
Route.select = () => { selects++; return { spot: { id: 'camp', center: { locX: 0, locY: 0 } }, row: { income: 100 + selects, kills: 10 } }; };
const at = 1791648945955;
const spots = [{ id: 'camp' }], otherSpots = [{ id: 'camp' }];
const row = (overrides = {}) => ({ characterId: 991001, phase: 'cold', level: 30, adena: 500, spotId: 'camp',
    loc: { locX: 0, locY: 0 }, inventory: { 57: { selfId: 57, amount: 500 } }, stats: { classId: 0, role: 'dps' },
    simulation: { ownerId: 'legacy_main', revision: 5 }, updatedAt: at, ...overrides });
const route = (state, timestamp = at, list = spots) => Income.soloRoute(state, list, timestamp, []);
try {
    const first = route(row());
    assert.equal(selects, 1);
    const again = route(row(), at + 1000);
    assert.equal(selects, 1, 'a fresh copy of an unchanged cold row reuses the held choice');
    assert.deepEqual(again, first, 'the held choice gives the same route');
    route(row({ simulation: { ownerId: 'legacy_main', revision: 6 } }), at + 2000);
    assert.equal(selects, 2, 'a new revision recomputes');
    route(row({ adena: 900 }), at + 3000);
    assert.equal(selects, 3, 'an out-of-band write that keeps the revision still recomputes');
    route(row({ adena: 900 }), at + 4000, otherSpots);
    assert.equal(selects, 4, 'another spots catalogue recomputes');
    route(row({ adena: 900 }), at + 4000 + Income.REVIEW_MS);
    assert.equal(selects, 5, 'the hold ends after REVIEW_MS');
    route(row({ adena: 900 }), at);
    assert.equal(selects, 6, 'an earlier timestamp recomputes');

    // Guarded out: not cold or no revision -> the per-object hold only (old behaviour).
    for (const guarded of [{ phase: 'hot' }, { simulation: { revision: 0 } }, { simulation: undefined }]) {
        const before = selects;
        const same = row({ characterId: 991002, ...guarded });
        route(same, at + 10000); route(same, at + 11000);
        assert.equal(selects, before + 1, 'the same object keeps its per-object hold');
        route(row({ characterId: 991002, ...guarded }), at + 12000);
        assert.equal(selects, before + 2, 'a fresh copy of a guarded state recomputes as before');
    }

    // Bounded: past the limit, entries older than REVIEW_MS are dropped in one pass.
    const old = at - Income.REVIEW_MS * 2;
    for (let id = 1; id <= 4097; id++) route(row({ characterId: 2000000 + id }), old);
    const count = selects;
    route(row({ characterId: 2000001 }), old + 1000);
    assert.equal(selects, count, 'held rows are reused while fresh');
    route(row({ characterId: 3000000 }), at);
    route(row({ characterId: 2000002 }), old + 2000);
    assert.equal(selects, count + 2, 'expired rows were dropped when the map passed its limit');
} finally {
    Route.select = original;
}
console.log('test_party_solo_route_hold passed');
