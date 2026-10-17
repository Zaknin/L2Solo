process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects the partyAck stage sample.
const assert = require('assert');
require('../src/Global');
const { ColdCommitQueue } = require('../src/GameServer/Bot/Population/ColdCommitQueue');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

// A party leader's deferred party work (afterCommit) leaves the flush free and
// holds only that leader's ack until the work settles.
function proposal(characterId) {
    return { proposalId: `p-${characterId}`, characterId, priority: 'P2', enqueuedAt: 0,
        token: { ok: true, characterId, ownerId: 'cold_simulation_owner', revision: 1, leaseId: `l-${characterId}`, leaseUntil: 30000 },
        baseState: { characterId, phase: 'cold', activity: 'hunting' }, result: { patch: {}, events: [] } };
}

(async () => {
    let release, started = 0;
    const work = new Promise(resolve => { release = resolve; });
    const rows = [];
    const queue = new ColdCommitQueue({
        prepare: async entry => entry.baseState,
        commit: async entries => entries.map(entry => ({ ok: true, characterId: entry.nextState.characterId })),
        afterCommit: async (entry) => { if (entry.nextState.characterId === 2) entry.deferred = () => { started += 1; return work; }; },
        onResults: values => rows.push(...values)
    });
    queue.enqueue(proposal(1));
    queue.enqueue(proposal(2));
    await queue.flushDue(true);
    assert.strictEqual(queue.flushing, false, 'the flush does not wait for deferred party work');
    assert.deepStrictEqual(rows.map(row => [row.characterId, !!row.deferred]), [[1, false], [2, true]]);
    assert.strictEqual(started, 0, 'the queue does not start the party work');

    const fenced = [];
    let settled = false;
    const fenceQueue = new ColdCommitQueue({
        prepare: async entry => entry.baseState,
        commit: async entries => entries.map(entry => ({ ok: true, characterId: entry.nextState.characterId })),
        afterCommit: async (entry) => { entry.deferred = () => new Promise(resolve => setTimeout(resolve, 20)).then(() => { settled = true; }); },
        onResults: values => fenced.push(...values.map(row => ({ ...row, settled })))
    });
    fenceQueue.enqueue(proposal(3));
    await fenceQueue.flushCharacter(3);
    assert.strictEqual(fenced[0].settled, true, 'a fence hands the bot over only after its party work');
    assert.strictEqual(fenced[0].deferred, undefined);

    const coordinator = new ColdSimulationCoordinator();
    const order = [];
    coordinator.handleCommitResults = async (results) => { order.push(`ack:${results.map(r => r.characterId).join(',')}`); };
    coordinator.queue.onResults(rows);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(started, 1);
    assert.ok(coordinator.heldAckAgeMs(2) >= 0 && coordinator.heldAcks.has(2) && !coordinator.heldAcks.has(1));
    assert.match(coordinator.overdueReason(2), /^held_ack:\d+s$/);
    order.push('settle');
    release();
    await Promise.allSettled([...coordinator.heldAcks.values()].map(held => held.ack));
    assert.deepStrictEqual(order, ['ack:1', 'settle', 'ack:2'], 'only the leader with deferred work waits for it');
    assert.strictEqual(coordinator.heldAcks.size, 0);
    assert.strictEqual(coordinator.queue.stageSamples.partyAck.length, 1);

    const finished = [];
    coordinator.finishCommitAcknowledgements = (results, acknowledged) => finished.push([results.map(r => r.characterId), acknowledged]);
    coordinator.recordError = () => {};
    coordinator.queue.onResults([{ ok: true, characterId: 4, deferred: () => Promise.reject(Error('chain_probe')) }]);
    await Promise.allSettled([...coordinator.heldAcks.values()].map(held => held.ack));
    assert.deepStrictEqual(finished, [[[4], false]], 'a failed chain releases the commit-ack waiter');
    console.log('cold commit held ack: ok');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
