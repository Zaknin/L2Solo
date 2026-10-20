'use strict';
// A worker proposal carries no base state: main commits it over its own
// cached state. A bot main does not hold in its
// cache gets the proposal refused, and its row stays as it was.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

const id = 730091;

async function lifeRow() {
    return (await Database.execute(['SELECT activity, simulationRevision, updatedAt FROM bot_life_state WHERE characterId=?', [id]]))[0];
}

(async () => {
    const world = await createWorld([{ id, classId: 0, level: 20 }], 'cold-proposal-compact');
    try {
        await Life.init();
        // The row is written after main loaded its cache: main holds no state for this bot.
        await Database.execute([`INSERT INTO bot_life_state (characterId, accountName, characterName, level,
            activity, phase, updatedAt, simulationRevision) VALUES (?, 'quests', 'Uncached', 20, 'resting', 'cold', 1000, 0)`, [id]]);
        assert.equal(Life.cachedState(id), null, 'fixture: main holds no state for the bot');
        const before = await lifeRow();

        const coordinator = new ColdSimulationCoordinator();
        coordinator.population = { realPlayerSessions: () => [], realPlayerSessionsNear: () => [] };
        const acks = [];
        coordinator.worker = { postMessage: message => message.type === 'commit_ack' && acks.push(...message.payload.results) };
        coordinator.workerEpoch = 'compact:fixture';
        const at = Date.now();
        const nextState = { characterId: id, accountName: 'quests', name: 'Uncached', phase: 'cold', activity: 'hunting',
            level: 20, exp: 0, sp: 0, adena: 0, loc: { locX: 1, locY: 1, locZ: 0 },
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, inventory: {}, stats: { classId: 0 },
            timing: { lastResolvedAt: at, nextResolveAt: at + 60000 }, simulation: { revision: 0 }, updatedAt: at };
        coordinator.handleProposalBatch({ payload: { proposals: [{
            proposalId: `${id}:1`, characterId: id, priority: 'P2', enqueuedAt: at, revision: 0,
            bagChanged: false, nextState,
            result: { events: [], debug: { activity: 'hunting' } },
            options: { allowLifecycle: true }
        }] } });
        await coordinator.queue.flushCharacter(id);
        for (let attempt = 0; attempt < 200 && !acks.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));

        assert.equal(acks.length, 1, 'the worker gets one ack for the proposal');
        assert.equal(acks[0].ok, false, 'a compact base cannot stand in for the state main does not hold');
        assert.equal(acks[0].reason, 'prepare_rejected');
        assert.deepEqual(await lifeRow(), before, 'no row is written');
        console.log('Cold proposal for an uncached bot is refused without a write');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
