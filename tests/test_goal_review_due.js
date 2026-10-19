const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

const Database = invoke('Database');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotClanChat = invoke('GameServer/Bot/AI/BotClanChat');

// A far bot that hunts alone re-reviews its goal when the goal's review time
// comes (GoalService's due list), with nothing else touching it; a near bot
// and a party member are left to their own review paths.
async function run() {
    const originals = { execute: Database.execute, upsert: Database.upsertBotGoalStates,
        cachedState: LifeState.cachedState, evaluate: NeedsEvaluator.evaluate, onGoal: BotClanChat.onGoal };
    const written = [];
    Database.execute = () => Promise.resolve([]);
    Database.upsertBotGoalStates = (rows) => { written.push(...rows.map(row => row.characterId)); return Promise.resolve(); };
    BotClanChat.onGoal = () => {};
    // Review times far ahead: the real timer never fires during the test.
    const now = Date.now() + 3600000;
    const states = new Map([
        [1, { characterId: 1, phase: 'cold', activity: 'hunting', party: { partyId: null }, stats: {} }],
        [2, { characterId: 2, phase: 'hot', activity: 'hunting', party: { partyId: null }, stats: {} }],
        [3, { characterId: 3, phase: 'cold', activity: 'grouped', party: { partyId: 'p-3' }, stats: {} }]
    ]);
    LifeState.cachedState = id => states.get(Number(id)) || null;
    const reviewed = [];
    NeedsEvaluator.evaluate = (state) => {
        reviewed.push(state.characterId);
        return [{ type: 'progress_level', priority: 50, blockers: [], plan: { expectedBenefit: 'experience_and_sp' },
            nextReviewAt: now + 120000 }];
    };
    try {
        const goal = (at) => JSON.stringify({ type: 'progress_level', status: 'active', nextReviewAt: at,
            plan: { expectedBenefit: 'experience_and_sp' } });
        GoalState.prime(1, goal(now + 1000));
        GoalState.prime(2, goal(now + 1000));
        GoalState.prime(3, goal(now + 1000));
        GoalState.prime(4, goal(now + 60000));
        GoalState.prime(5, '{}');
        states.set(5, { characterId: 5, phase: 'cold', activity: 'hunting', party: { partyId: null }, stats: {} });
        assert.strictEqual(GoalService.dueArmedAt(), now + 1000, 'one timer, armed at the earliest review time');

        assert.deepStrictEqual(await GoalService.reviewDue(now), [], 'nothing is reviewed before its time');
        await GoalService.reviewDue(now + 1000);
        assert.deepStrictEqual(reviewed, [1], 'only the far solo bot is reviewed when its time comes');
        assert.deepStrictEqual(written, [1]);
        assert.strictEqual(GoalState.snapshot(1).current.nextReviewAt, now + 120000, 'the review wrote the next review time');
        assert.strictEqual(GoalState.snapshot(2).current.nextReviewAt, now + 1000, 'a near bot keeps its own review path');
        assert.strictEqual(GoalState.snapshot(3).current.nextReviewAt, now + 1000, 'a party member keeps its own review path');

        // The reviewed goal is due again at its new time; the left-out bots are not polled again.
        reviewed.length = 0;
        await GoalService.reviewDue(now + 60000);
        assert.deepStrictEqual(reviewed, [], 'bot 4 is not cached as a state: nothing to review');
        await GoalService.reviewDue(now + 120000);
        assert.deepStrictEqual(reviewed, [1], 'the far solo bot is reviewed again at its next review time');
        assert(!reviewed.includes(5), 'a bot without a goal has no review time');

        GoalState.reset();
        assert.strictEqual(GoalService.dueArmedAt(), Infinity, 'a reset leaves no timer');
    } finally {
        Object.assign(Database, { execute: originals.execute, upsertBotGoalStates: originals.upsert });
        LifeState.cachedState = originals.cachedState;
        NeedsEvaluator.evaluate = originals.evaluate;
        BotClanChat.onGoal = originals.onGoal;
        GoalState.reset();
    }
    console.log('PASS a far solo bot re-reviews its goal at its review time; near and party bots are left out');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
