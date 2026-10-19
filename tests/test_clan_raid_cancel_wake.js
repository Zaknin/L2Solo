// A cancelled unopened raid party wakes the clan goal review so it can try again.
const assert = require('assert');

require('../src/Global');

const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const Roster = require('../src/GameServer/Clan/ClanRaidRoster');
const ReviewEvents = require('../src/GameServer/Clan/ClanReviewEvents');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');

const ids = Array.from({ length: 9 }, (_, index) => index + 1);
const marker = { clanId: 7, ownerSection: 'goal', goalKey: 'g1', generation: 'v1', memberIds: ids,
    sourceId: 'raid:123', npcId: 123, raidInstanceId: 'spawn1', minPartySize: 9, maxPartySize: 9 };
const party = { partyId: 'p1', status: 'active', memberIds: ids, spotId: marker.sourceId, updatedAt: 5, revision: 2,
    stats: { objective: { fullRoster: marker } } };

async function main() {
    const original = { find: Parties.find, createOrUpdate: Parties.createOrUpdate, release: Life.releaseDissolvedPartyMembers,
        execute: Database.execute, enqueueClanAction: Database.enqueueClanAction };
    let stored = party, released = [];
    try {
        Parties.find = () => stored;
        Parties.createOrUpdate = async next => { stored = next; return next; };
        Life.releaseDissolvedPartyMembers = async (partyId, reason) => { released.push([partyId, reason]); };
        await ReviewEvents.drain(null, 1000);

        // A stale party (changed since the caller read it) is not cancelled and wakes nothing.
        stored = { ...party, revision: 3 };
        assert.strictEqual(await Roster.cancelUnopened(party, 'raid_roster_owner_changed'), false);
        assert.deepStrictEqual(await ReviewEvents.drain(null), []);

        stored = party;
        assert.strictEqual(await Roster.cancelUnopened(party, 'raid_roster_owner_changed'), true);
        assert.strictEqual(stored.status, 'dissolved');
        assert.deepStrictEqual(released, [['p1', 'raid_roster_owner_changed']]);
        // The clan goal stays executing in the owner row; only a review wake gives it a new attempt.
        const events = await ReviewEvents.drain(null);
        assert.deepStrictEqual(events, [{ clanId: 7, causes: ['raid_cancelled'] }]);

        // The wake reaches the planner: a clan plan action is queued with that reason.
        const queued = [];
        Database.execute = async () => [];
        Database.enqueueClanAction = async row => { queued.push(row); return { ok: true }; };
        ReviewEvents.changed(7, 'raid_cancelled');
        await ClanActionService.scheduleReviews();
        const plan = queued.find(row => row.actionType === 'goal_plan');
        assert(plan && plan.clanId === 7);
        assert.deepStrictEqual(plan.payload.reasons, ['raid_cancelled']);
    } finally {
        Object.assign(Parties, { find: original.find, createOrUpdate: original.createOrUpdate });
        Life.releaseDissolvedPartyMembers = original.release;
        Object.assign(Database, { execute: original.execute, enqueueClanAction: original.enqueueClanAction });
    }
    console.log('Clan raid cancel wake test passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
