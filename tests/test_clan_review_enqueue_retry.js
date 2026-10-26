// A failed enqueue must not lose the review events that drain() already removed.
const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const ReviewEvents = require('../src/GameServer/Clan/ClanReviewEvents');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');

async function main() {
    const original = { execute: Database.execute, enqueueClanAction: Database.enqueueClanAction };
    try {
        // Leftovers from other modules loading must not leak into this check.
        await ReviewEvents.drain(null, 1000);
        for (const id of [1, 2, 3]) ReviewEvents.changed(id, 'warehouse');
        ReviewEvents.changed(2, 'board');
        let enqueues = 0;
        Database.execute = async () => [];
        Database.enqueueClanAction = async () => { enqueues++; throw new Error('injected_database_failure'); };
        await assert.rejects(ClanActionService.scheduleReviews(), /injected_database_failure/);
        assert.strictEqual(enqueues, 1);
        const retry = await ReviewEvents.drain(null);
        // The failing clan and every clan drained after it are all visited again.
        assert.deepStrictEqual(retry.map(row => row.clanId).sort(), [1, 2, 3]);
        const causes = clanId => retry.find(row => row.clanId === clanId).causes;
        assert(causes(2).includes('warehouse') && causes(2).includes('board'), 'later clan keeps its own causes');
        assert(causes(3).includes('warehouse'));
        assert(causes(1).includes('warehouse') && causes(1).includes('review_retry'), 'failing clan keeps its causes');

        // The retried events reach the planner: both actions are enqueued for each clan.
        const queued = [];
        Database.enqueueClanAction = async row => { queued.push(row); return { ok: true }; };
        for (const row of retry) for (const cause of row.causes) ReviewEvents.changed(row.clanId, cause);
        await ClanActionService.scheduleReviews();
        assert.deepStrictEqual([...new Set(queued.map(row => row.clanId))].sort(), [1, 2, 3]);
        assert(queued.some(row => row.actionType === 'goal_plan'));
        assert.deepStrictEqual(await ReviewEvents.drain(null), []);
    } finally { Object.assign(Database, original); }
    console.log('Clan review enqueue retry test passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
