// The hall tick settles only at a deadline Repository.settle acts on: an auction
// end, a rent or service date (unpaid rent stays due), or an owner clan missing.
const assert = require('assert');
require('../src/Global');
const Runtime = require('../src/GameServer/ClanHall/Runtime');
const Clans = invoke('GameServer/Clan/ClanService');
const Database = invoke('Database');
const SimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const original = { tick: Database.tickClanHalls, list: Database.fetchClanHallAuctions,
    clan: Clans.findById, enabled: SimulationConfig.enabled };
async function main() {
    const now = Date.now(), HOUR = 3600000;
    let rows = [], settles = 0;
    Database.tickClanHalls = async () => { settles++; return rows; };
    Database.fetchClanHallAuctions = async () => rows;
    Clans.findById = id => ({ id });
    SimulationConfig.enabled = false;
    try {
        const free = { id: 22, ownerId: 0, functionsJson: '{}', auctionEndsAt: now + HOUR, rentDueAt: 0, serviceDueAt: 0 };
        const owned = { id: 23, ownerId: 5, functionsJson: '{}', auctionEndsAt: 0, rentDueAt: now + 2 * HOUR, serviceDueAt: now + 3 * HOUR };
        rows = [free, owned];
        Runtime.applyRows(rows);
        await Runtime.tick();
        assert.equal(settles, 0, 'no deadline passed: the tick does not settle');

        rows = [{ ...free, auctionEndsAt: now - 1 }, owned];
        Runtime.applyRows(rows);
        await Runtime.tick();
        assert.equal(settles, 1, 'a passed auction end settles');

        rows = [free, { ...owned, rentDueAt: now - 1 }];
        Runtime.applyRows(rows);
        await Runtime.tick(); await Runtime.tick();
        assert.equal(settles, 3, 'an unpaid rent keeps its past date and stays due every tick');

        rows = [free, { ...owned, serviceDueAt: now - 1 }];
        Runtime.applyRows(rows);
        await Runtime.tick();
        assert.equal(settles, 4, 'a passed service date settles');

        rows = [free, owned];
        Runtime.applyRows(rows);
        Clans.findById = id => (id === 5 ? null : { id });
        await Runtime.tick();
        assert.equal(settles, 5, 'an owner clan missing from the cache settles (release)');

        Clans.findById = id => ({ id });
        Runtime.applyRows([]);
        await Runtime.tick();
        assert.equal(settles, 5, 'no halls: nothing to settle');
        console.log('test_clan_hall_settle_gate: auction end, rent, unpaid rent, service, missing owner gates passed');
    } finally {
        Database.tickClanHalls = original.tick;
        Database.fetchClanHallAuctions = original.list;
        Clans.findById = original.clan;
        SimulationConfig.enabled = original.enabled;
        Runtime.stop();
    }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
